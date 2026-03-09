/**
 * Cloudflare Worker: escolinha-api-worker
 * Utiliza o Driver Oficial do MongoDB com compatibilidade Node.js.
 * Consolida todas as funções GET do Netlify para economia de limites.
 * Adicionado suporte a Paginação Real (limit, skip, total).
 */

import { MongoClient } from 'mongodb';

let cachedClient = null;
let globalEventSnapshot = null; // Cache L1 Ultra-Rápido Intenamente Isolado na RAM da Cloudflare
let lastFetchTime = 0;

async function getClient(uri) {
    if (cachedClient) return cachedClient;
    const client = new MongoClient(uri);
    await client.connect();
    cachedClient = client;
    return client;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const params = url.searchParams;

        const nickname = params.get('nickname');
        const limit = Math.min(parseInt(params.get('limit')) || 20, 100);
        const skip = Math.max(parseInt(params.get('skip')) || 0, 0);
        const aulaName = params.get('aula_name');

        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'application/json',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            if (!env.MONGODB_URI) {
                throw new Error('MONGODB_URI não configurada.');
            }

            const client = await getClient(env.MONGODB_URI);
            const db = client.db('escolinha');

            const cache = typeof caches !== 'undefined' ? caches.default : null;
            let cachedResponse = null;
            const cacheKey = new Request(url.toString(), request);

            if (cache) {
                cachedResponse = await cache.match(cacheKey);
                if (cachedResponse) return cachedResponse;
            }

            let responseData = null;
            let cacheTtl = 0; // Segundos (0 = sem cache por padrão)

            switch (pathname) {
                case '/getUserTickets': {
                    if (!nickname) throw new Error('Nickname é obrigatório');

                    // Lendo Tickets via D1 Cache
                    const { results: tRes } = await env.DB.prepare("SELECT json_data FROM server_cache WHERE key = 'event_tickets_snapshot'").all();
                    const snapshot = tRes?.[0]?.json_data ? JSON.parse(tRes[0].json_data) : null;
                    const allRaw = snapshot ? [...(snapshot.rawMamute || []), ...(snapshot.rawSemanal || [])] : [];

                    const regex = new RegExp(`^${nickname}$`, 'i');
                    const filtered = allRaw.filter(t => regex.test(t.nickname));

                    const ticketCounts = filtered.reduce((acc, t) => {
                        const type = t.ticket_type || t.item_id || 'unknown';
                        acc[type] = (acc[type] || 0) + 1;
                        return acc;
                    }, {});

                    // Lendo Perfil e Oinc Points via D1 Cache
                    const { results: pRes } = await env.DB.prepare("SELECT json_data FROM server_cache WHERE key = 'profiles_snapshot'").all();
                    const profiles = pRes?.[0]?.json_data ? JSON.parse(pRes[0].json_data) : [];
                    const profile = profiles.find(p => p.nickname && p.nickname.toLowerCase() === nickname.toLowerCase());

                    responseData = {
                        nickname: profile?.nickname || nickname,
                        avatar: profile?.image || profile?.avatar_url || null,
                        points: profile?.oinc_points || 0,
                        tickets: ticketCounts
                    };
                    break;
                }

                case '/get-sorteio-status': {
                    // Consulta local super-rápida via SQL D1 do estado guardado pelo Cron
                    const { results } = await env.DB.prepare("SELECT json_data FROM server_cache WHERE key = 'sorteio_status_snapshot'").all();
                    const statusDoc = results?.[0]?.json_data ? JSON.parse(results[0].json_data) : null;
                    const lastDrawnDate = statusDoc?.last_drawn ? new Date(statusDoc.last_drawn) : new Date(0);

                    const now = new Date();
                    const brtOffset = -3;
                    let nowBrt = new Date(now.getTime() + (brtOffset * 3600 * 1000));
                    let mostRecentPastSunday21h = new Date(nowBrt);

                    const diffToSunday = nowBrt.getUTCDay();
                    if (diffToSunday === 0 && nowBrt.getUTCHours() >= 21) {
                        mostRecentPastSunday21h.setUTCHours(21, 0, 0, 0);
                    } else {
                        let daysToSubtract = diffToSunday === 0 ? 7 : diffToSunday;
                        mostRecentPastSunday21h.setUTCDate(mostRecentPastSunday21h.getUTCDate() - daysToSubtract);
                        mostRecentPastSunday21h.setUTCHours(21, 0, 0, 0);
                    }

                    const realMostRecentSundayUTC = new Date(mostRecentPastSunday21h.getTime() - (brtOffset * 3600 * 1000));
                    responseData = {
                        isOpen: lastDrawnDate >= realMostRecentSundayUTC,
                        lastDrawnDate: lastDrawnDate.toISOString(),
                        mostRecentPastSunday21hUTC: realMostRecentSundayUTC.toISOString(),
                        nowUTC: now.toISOString()
                    };
                    cacheTtl = 60; // 1 min de cache
                    break;
                }

                case '/get-raffle-winners': {
                    const forceRefresh = params.has('__t');
                    const { results } = await env.DB.prepare("SELECT json_data FROM server_cache WHERE key = 'raffle_winners_snapshot'").all();
                    const allData = results?.[0]?.json_data ? JSON.parse(results[0].json_data) : [];
                    const data = allData.slice(skip, skip + limit);
                    responseData = { data, total: allData.length };
                    cacheTtl = forceRefresh ? 0 : 30; // Bypass cache de borda se for refresh forçado
                    break;
                }

                case '/get-event-tickets': {
                    const type = params.get('type');
                    const mode = params.get('mode'); // 'ranking' ou 'list'
                    const forceRefresh = params.has('__t');
                    const needsStats = params.get('stats') === 'true' || (!nickname && (mode === 'list' || mode === 'ranking' || !mode));

                    if (nickname) {
                        // Busca individual usando cache D1 em O(1) + regex filter em memória
                        try {
                            const { results } = await env.DB.prepare("SELECT json_data FROM server_cache WHERE key = 'event_tickets_snapshot'").all();
                            if (results && results.length > 0 && results[0].json_data) {
                                const snapshot = JSON.parse(results[0].json_data);
                                const allRaw = [...(snapshot.rawMamute || []), ...(snapshot.rawSemanal || [])];
                                const regex = new RegExp(`^${nickname}$`, 'i');
                                const filtered = allRaw.filter(t => t.nickname && regex.test(t.nickname));
                                const data = filtered.slice(skip, skip + limit);
                                responseData = { data, total: filtered.length, stats: null };
                            } else {
                                responseData = { data: [], total: 0, stats: null };
                            }
                        } catch (e) {
                            responseData = { data: [], total: 0, stats: null };
                        }
                        break;
                    }

                    // --- INICIO DO CONTROLE DE CACHE L1 ULTRA RÁPIDO NA RAM ---
                    const CACHE_VALIDITY_MS = 10 * 60 * 1000; // 10 Minutos

                    if (forceRefresh || !globalEventSnapshot || (Date.now() - lastFetchTime) > CACHE_VALIDITY_MS) {
                        try {
                            // Puxa do Cloudflare D1 localmente (Zero CPU load de Rede)
                            const { results } = await env.DB.prepare(
                                "SELECT json_data FROM server_cache WHERE key = 'event_tickets_snapshot'"
                            ).all();

                            if (results && results.length > 0 && results[0].json_data) {
                                globalEventSnapshot = JSON.parse(results[0].json_data);
                                lastFetchTime = Date.now();
                            }
                        } catch (d1Err) {
                            console.error("D1 Cache Miss / Fallback Error:", d1Err);
                        }
                    }

                    const snapshot = globalEventSnapshot;

                    if (!snapshot) {
                        // Fallback do sistema: Se por algum acaso Cron nao gerou cache, retorne vazio para evitar gargalo 500 do cloudflare timeoutando.
                        if (mode === 'list') {
                            responseData = { data: [], total: 0, stats: null };
                        } else {
                            responseData = { data: [], stats: null };
                        }
                    } else {
                        // --- SUCESSO DO CACHE L1 (Zero Latency I/O) ---
                        if (mode === 'list') {
                            let rawData = type === 'ticket_mamute' ? snapshot.rawMamute :
                                type === 'ticket_semanal' ? snapshot.rawSemanal :
                                    [...(snapshot.rawMamute || []), ...(snapshot.rawSemanal || [])];

                            responseData = { data: rawData || [], total: rawData?.length || 0, stats: needsStats ? snapshot.stats : null };
                        } else {
                            let rankingData = type === 'ticket_mamute' ? snapshot.rankingMamute :
                                type === 'ticket_semanal' ? snapshot.rankingSemanal :
                                    snapshot.rankingGeral;

                            responseData = {
                                data: rankingData || [],
                                stats: needsStats ? snapshot.stats : null
                            };
                        }
                    }

                    cacheTtl = 30;
                    break;
                }

                case '/get-estrela-logs': {
                    const search = params.get('search');

                    const { results } = await env.DB.prepare("SELECT json_data FROM server_cache WHERE key = 'estrela_logs_snapshot'").all();
                    const allLogs = results?.[0]?.json_data ? JSON.parse(results[0].json_data) : [];

                    let filtered = allLogs;
                    if (nickname || search) {
                        const nickRegex = nickname ? new RegExp(nickname, 'i') : null;
                        const searchRegex = search ? new RegExp(search, 'i') : null;

                        filtered = allLogs.filter(log => {
                            let matchNick = true;
                            let matchSearch = true;
                            if (nickRegex && log.nickname) matchNick = nickRegex.test(log.nickname);
                            if (searchRegex) {
                                matchSearch = (log.nickname && searchRegex.test(log.nickname)) || (log.reason && searchRegex.test(log.reason));
                            }
                            return matchNick && matchSearch;
                        });
                    }

                    const data = filtered.slice(skip, skip + limit);
                    const total = filtered.length;

                    const stats = { add: 0, remove: 0, edit: 0, auto_remove: 0 };
                    filtered.forEach(log => {
                        if (log.action && stats.hasOwnProperty(log.action)) {
                            stats[log.action]++;
                        }
                    });

                    responseData = { data, total, limit, skip, stats };
                    cacheTtl = 60; // 1 min cache
                    break;
                }

                case '/get-cantina-logs': {
                    const search = params.get('search');
                    const type = params.get('type');
                    const month = params.get('month'); // 0-11 ou 'todos'
                    const year = params.get('year');

                    const { results } = await env.DB.prepare("SELECT json_data FROM server_cache WHERE key = 'cantina_logs_snapshot'").all();
                    const allLogs = results?.[0]?.json_data ? JSON.parse(results[0].json_data) : [];

                    let filtered = allLogs;

                    if (nickname || search || (type && type !== 'todos') || (month && month !== 'todos') || year) {
                        const nickRegex = nickname ? new RegExp(nickname, 'i') : null;
                        const searchRegex = search ? new RegExp(search, 'i') : null;
                        const targetMonth = month && month !== 'todos' ? parseInt(month) : null;
                        const targetYear = year ? parseInt(year) : null;

                        filtered = allLogs.filter(log => {
                            let matchNick = true;
                            let matchSearch = true;
                            let matchType = true;
                            let matchDate = true;

                            if (nickRegex && log.nickname) matchNick = nickRegex.test(log.nickname);

                            if (searchRegex) {
                                matchSearch = (log.nickname && searchRegex.test(log.nickname)) ||
                                    (log.reason && searchRegex.test(log.reason));
                            }

                            if (type && type !== 'todos') {
                                matchType = (log.type === type);
                            }

                            if (targetMonth !== null || targetYear !== null) {
                                const logDate = new Date(log.created_at);
                                if (targetMonth !== null && logDate.getMonth() !== targetMonth) matchDate = false;
                                if (targetYear !== null && logDate.getFullYear() !== targetYear) matchDate = false;
                            }

                            return matchNick && matchSearch && matchType && matchDate;
                        });
                    }

                    const data = filtered.slice(skip, skip + limit);
                    const total = filtered.length;

                    const stats = filtered.reduce((acc, log) => {
                        const change = log.change || 0;
                        if (change > 0) acc.pointsAdded += change;
                        else if (change < 0) acc.pointsRemoved += Math.abs(change);
                        return acc;
                    }, { pointsAdded: 0, pointsRemoved: 0 });

                    responseData = { data, total, limit, skip, stats };
                    cacheTtl = 60;
                    break;
                }

                case '/get-logs': {
                    const aula_name = params.get('aula_name');
                    const search = params.get('search');

                    const { results } = await env.DB.prepare("SELECT json_data FROM server_cache WHERE key = 'logs_snapshot'").all();
                    const allLogs = results?.[0]?.json_data ? JSON.parse(results[0].json_data) : [];

                    let filtered = allLogs;
                    if (aula_name || search) {
                        const searchRegex = search ? new RegExp(search, 'i') : null;

                        filtered = allLogs.filter(log => {
                            let matchAula = true;
                            let matchSearch = true;
                            if (aula_name && log.aula_name !== aula_name) matchAula = false;
                            if (searchRegex) {
                                matchSearch = (log.nickname && searchRegex.test(log.nickname)) || (log.reason && searchRegex.test(log.reason));
                            }
                            return matchAula && matchSearch;
                        });
                    }

                    const data = filtered.slice(skip, skip + limit);
                    const total = filtered.length;

                    responseData = { data, total, limit, skip };
                    cacheTtl = 60;
                    break;
                }

                default:
                    return new Response(JSON.stringify({ error: 'Rota não encontrada' }), { status: 404, headers: corsHeaders });
            }

            const response = new Response(JSON.stringify(responseData), { headers: corsHeaders });
            if (cacheTtl > 0 && cache) {
                response.headers.set('Cache-Control', `public, max-age=${cacheTtl}`);
                ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }
            return response;

        } catch (error) {
            // Se der erro, ejetar do cache para evitar que o pool segure conexões mortas pro MongoDB
            cachedClient = null;
            return new Response(JSON.stringify({
                error: error.message,
                stack: error.stack,
                path: pathname
            }), { status: 500, headers: corsHeaders });
        }
    },

    // CRON TRIGGER EVENT
    // Responsável por calcular e gerar a 'materialized view' pesada no mongo em background,
    // garantindo zero latência no front-end por requests complexas.
    async scheduled(event, env, ctx) {
        try {
            if (!env.MONGODB_URI) {
                console.error("Cron falhou: MONGODB_URI nula");
                return;
            }

            const client = await getClient(env.MONGODB_URI);
            const db = client.db('escolinha');
            const now = new Date();

            console.log("⏱️ Iniciando Sincronia de Estado Total...");

            // 1. Busca PARALELA de todos os dados necessários (Performance Máxima)
            const [
                allTickets,
                sorteioStatus,
                raffleWinners,
                estrelaLogs,
                cantinaLogs,
                profiles,
                actLogs
            ] = await Promise.all([
                db.collection('event_tickets').find({}).toArray(),
                db.collection('sorteio_settings').findOne({ type: 'semanal_status' }),
                db.collection('raffle_winners').find({}).sort({ created_at: -1 }).toArray(),
                db.collection('estrela_logs').find({}).sort({ created_at: -1 }).limit(5000).toArray(),
                db.collection('cantina_logs').find({}).sort({ created_at: -1 }).limit(5000).toArray(),
                db.collection('profiles').find({}, { projection: { nickname: 1, image: 1, avatar_url: 1, oinc_points: 1 } }).toArray(),
                db.collection('logs').find({}).sort({ created_at: -1 }).limit(5000).toArray()
            ]);

            // 2. Inicializa novo Snapshot (Estado Limpo)
            const snapshot = {
                stats: { mamute: 0, semanal: 0, totalPlayers: 0, totalTickets: 0 },
                rankingMamute: [],
                rankingSemanal: [],
                rankingGeral: [],
                rawMamute: [],
                rawSemanal: [],
                updatedAt: now
            };

            // 3. Processa todos os tickets (Garantia de Sincronia com Deleções)
            allTickets.forEach(t => {
                if (t.ticket_type === 'ticket_mamute') snapshot.rawMamute.push(t);
                if (t.ticket_type === 'ticket_semanal') snapshot.rawSemanal.push(t);
            });

            const uniqueNicks = new Set(allTickets.map(t => String(t.nickname).toLowerCase()));
            snapshot.stats = {
                mamute: snapshot.rawMamute.length,
                semanal: snapshot.rawSemanal.length,
                totalTickets: allTickets.length,
                totalPlayers: uniqueNicks.size
            };

            // 4. Reconstrói Rankings em Memória
            const buildRamRanking = (ticketsList, typeStr) => {
                const map = {};
                ticketsList.forEach(t => {
                    const nick = t.nickname;
                    if (!map[nick]) {
                        map[nick] = {
                            nickname: nick,
                            display_name: t.display_name || nick,
                            tickets: 0,
                            image: "https://escolinhaavalon.online/assets/icon-Bz0c5v1i.webp",
                            ticket_type: typeStr
                        };
                    }
                    map[nick].tickets += 1;
                });
                return Object.values(map).sort((a, b) => b.tickets - a.tickets).slice(0, 1000);
            };

            snapshot.rankingMamute = buildRamRanking(snapshot.rawMamute, 'ticket_mamute');
            snapshot.rankingSemanal = buildRamRanking(snapshot.rawSemanal, 'ticket_semanal');
            snapshot.rankingGeral = buildRamRanking(allTickets, 'geral');

            // 5. Garantir Tabela de Cache no D1
            await env.DB.prepare(`
                CREATE TABLE IF NOT EXISTS server_cache (
                    key TEXT PRIMARY KEY,
                    json_data TEXT,
                    updated_at DATETIME
                )
            `).run();

            // 6. Atualização em Lote no D1 (Atômico e Rápido)
            const insertStmt = "INSERT INTO server_cache (key, json_data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json_data=excluded.json_data, updated_at=excluded.updated_at";

            await env.DB.batch([
                env.DB.prepare(insertStmt).bind('event_tickets_snapshot', JSON.stringify(snapshot), now.toISOString()),
                env.DB.prepare(insertStmt).bind('sorteio_status_snapshot', JSON.stringify(sorteioStatus || {}), now.toISOString()),
                env.DB.prepare(insertStmt).bind('raffle_winners_snapshot', JSON.stringify(raffleWinners || []), now.toISOString()),
                env.DB.prepare(insertStmt).bind('estrela_logs_snapshot', JSON.stringify(estrelaLogs || []), now.toISOString()),
                env.DB.prepare(insertStmt).bind('cantina_logs_snapshot', JSON.stringify(cantinaLogs || []), now.toISOString()),
                env.DB.prepare(insertStmt).bind('profiles_snapshot', JSON.stringify(profiles || []), now.toISOString()),
                env.DB.prepare(insertStmt).bind('logs_snapshot', JSON.stringify(actLogs || []), now.toISOString())
            ]);

            // Atualiza Cache L1 (RAM)
            globalEventSnapshot = snapshot;
            lastFetchTime = Date.now();

            console.log(`✅ Sincronia de Estado Total Concluída. Ativos: ${allTickets.length} tickets. Usuarios: ${snapshot.stats.totalPlayers}`);

        } catch (error) {
            console.error("❌ Erro ao computar snapshot do Cron Job Incremental:", error);
            cachedClient = null;
        }
    }
};

