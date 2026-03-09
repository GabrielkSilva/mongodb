import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';

const app = express();
app.use(cors());
app.use(express.json());

let cachedClient = null;

async function getDb() {
    if (!cachedClient) {
        cachedClient = new MongoClient(process.env.MONGODB_URI);
        await cachedClient.connect();
    }
    return cachedClient.db('escolinha');
}

function esc(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nicknameFilter(nickname) {
    return { $regex: `^${esc(nickname)}$`, $options: 'i' };
}

function parsePagination(query) {
    return {
        limit: Math.min(parseInt(query.limit) || 20, 100),
        skip: Math.max(parseInt(query.skip) || 0, 0),
    };
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'escolinha-api', uptime: process.uptime() });
});

app.get('/getUserTickets', async (req, res) => {
    try {
        const db = await getDb();
        const { nickname } = req.query;

        if (!nickname) return res.status(400).json({ error: 'Nickname é obrigatório' });

        const nf = nicknameFilter(nickname);

        const [ticketAgg, profile] = await Promise.all([
            db.collection('event_tickets').aggregate([
                { $match: { nickname: nf } },
                {
                    $group: {
                        _id: { $ifNull: ['$ticket_type', { $ifNull: ['$item_id', 'unknown'] }] },
                        count: { $sum: 1 }
                    }
                }
            ]).toArray(),
            db.collection('profiles').findOne(
                { nickname: nf },
                { projection: { nickname: 1, image: 1, avatar_url: 1, oinc_points: 1 } }
            )
        ]);

        const tickets = {};
        ticketAgg.forEach(t => { tickets[t._id] = t.count; });

        res.json({
            nickname: profile?.nickname || nickname,
            avatar: profile?.image || profile?.avatar_url || null,
            points: profile?.oinc_points || 0,
            tickets
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/get-sorteio-status', async (req, res) => {
    try {
        const db = await getDb();
        const statusDoc = await db.collection('sorteio_settings').findOne({ type: 'semanal_status' });
        const lastDrawnDate = statusDoc?.last_drawn ? new Date(statusDoc.last_drawn) : new Date(0);

        const now = new Date();
        const brtOffset = -3;
        const nowBrt = new Date(now.getTime() + (brtOffset * 3600 * 1000));
        const mostRecentPastSunday21h = new Date(nowBrt);

        const diffToSunday = nowBrt.getUTCDay();
        if (diffToSunday === 0 && nowBrt.getUTCHours() >= 21) {
            mostRecentPastSunday21h.setUTCHours(21, 0, 0, 0);
        } else {
            const daysToSubtract = diffToSunday === 0 ? 7 : diffToSunday;
            mostRecentPastSunday21h.setUTCDate(mostRecentPastSunday21h.getUTCDate() - daysToSubtract);
            mostRecentPastSunday21h.setUTCHours(21, 0, 0, 0);
        }

        const realMostRecentSundayUTC = new Date(mostRecentPastSunday21h.getTime() - (brtOffset * 3600 * 1000));

        res.json({
            isOpen: lastDrawnDate >= realMostRecentSundayUTC,
            lastDrawnDate: lastDrawnDate.toISOString(),
            mostRecentPastSunday21hUTC: realMostRecentSundayUTC.toISOString(),
            nowUTC: now.toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/get-raffle-winners', async (req, res) => {
    try {
        const db = await getDb();
        const { limit, skip } = parsePagination(req.query);

        const [data, total] = await Promise.all([
            db.collection('raffle_winners').find({}).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
            db.collection('raffle_winners').countDocuments({})
        ]);

        res.json({ data, total });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/get-event-tickets', async (req, res) => {
    try {
        const db = await getDb();
        const { nickname, type, mode, stats: wantStats } = req.query;
        const { limit, skip } = parsePagination(req.query);
        const col = db.collection('event_tickets');
        const needsStats = wantStats === 'true' || (!nickname && (mode === 'list' || mode === 'ranking' || !mode));

        if (nickname) {
            const filter = { nickname: nicknameFilter(nickname) };
            const [data, total] = await Promise.all([
                col.find(filter).skip(skip).limit(limit).toArray(),
                col.countDocuments(filter)
            ]);
            return res.json({ data, total, stats: null });
        }

        let stats = null;
        if (needsStats) {
            const [mamuteCount, semanalCount, totalCount, playerResult] = await Promise.all([
                col.countDocuments({ ticket_type: 'ticket_mamute' }),
                col.countDocuments({ ticket_type: 'ticket_semanal' }),
                col.countDocuments({}),
                col.aggregate([
                    { $group: { _id: { $toLower: '$nickname' } } },
                    { $count: 'total' }
                ]).toArray()
            ]);
            stats = {
                mamute: mamuteCount,
                semanal: semanalCount,
                totalTickets: totalCount,
                totalPlayers: playerResult[0]?.total || 0
            };
        }

        if (mode === 'list') {
            const typeFilter = type ? { ticket_type: type } : {};
            const data = await col.find(typeFilter).toArray();
            return res.json({ data, total: data.length, stats });
        }

        const matchStage = type ? { $match: { ticket_type: type } } : { $match: {} };
        const typeStr = type || 'geral';

        const data = await col.aggregate([
            matchStage,
            {
                $group: {
                    _id: '$nickname',
                    display_name: { $first: { $ifNull: ['$display_name', '$nickname'] } },
                    tickets: { $sum: 1 }
                }
            },
            { $sort: { tickets: -1 } },
            { $limit: 1000 },
            {
                $project: {
                    _id: 0,
                    nickname: '$_id',
                    display_name: 1,
                    tickets: 1,
                    ticket_type: { $literal: typeStr },
                    image: { $literal: 'https://escolinhaavalon.online/assets/icon-Bz0c5v1i.webp' }
                }
            }
        ]).toArray();

        res.json({ data, stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/get-estrela-logs', async (req, res) => {
    try {
        const db = await getDb();
        const { nickname, search } = req.query;
        const { limit, skip } = parsePagination(req.query);
        const col = db.collection('estrela_logs');

        const filter = {};
        if (nickname) filter.nickname = { $regex: esc(nickname), $options: 'i' };
        if (search) {
            filter.$or = [
                { nickname: { $regex: esc(search), $options: 'i' } },
                { reason: { $regex: esc(search), $options: 'i' } }
            ];
        }

        const [data, total, statsAgg] = await Promise.all([
            col.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
            col.countDocuments(filter),
            col.aggregate([
                { $match: filter },
                { $group: { _id: '$action', count: { $sum: 1 } } }
            ]).toArray()
        ]);

        const stats = { add: 0, remove: 0, edit: 0, auto_remove: 0 };
        statsAgg.forEach(s => {
            if (stats.hasOwnProperty(s._id)) stats[s._id] = s.count;
        });

        res.json({ data, total, limit, skip, stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/get-cantina-logs', async (req, res) => {
    try {
        const db = await getDb();
        const { nickname, search, type, month, year } = req.query;
        const { limit, skip } = parsePagination(req.query);
        const col = db.collection('cantina_logs');

        const filter = {};
        if (nickname) filter.nickname = { $regex: esc(nickname), $options: 'i' };
        if (search) {
            filter.$or = [
                { nickname: { $regex: esc(search), $options: 'i' } },
                { reason: { $regex: esc(search), $options: 'i' } }
            ];
        }
        if (type && type !== 'todos') filter.type = type;

        if ((month && month !== 'todos') || year) {
            const targetMonth = month && month !== 'todos' ? parseInt(month) : null;
            const targetYear = year ? parseInt(year) : null;

            if (targetYear !== null && targetMonth !== null) {
                const start = new Date(targetYear, targetMonth, 1);
                const end = new Date(targetYear, targetMonth + 1, 1);
                filter.created_at = { $gte: start.toISOString(), $lt: end.toISOString() };
            } else if (targetYear !== null) {
                const start = new Date(targetYear, 0, 1);
                const end = new Date(targetYear + 1, 0, 1);
                filter.created_at = { $gte: start.toISOString(), $lt: end.toISOString() };
            } else if (targetMonth !== null) {
                const currentYear = new Date().getFullYear();
                const start = new Date(currentYear, targetMonth, 1);
                const end = new Date(currentYear, targetMonth + 1, 1);
                filter.created_at = { $gte: start.toISOString(), $lt: end.toISOString() };
            }
        }

        const [data, total, statsAgg] = await Promise.all([
            col.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
            col.countDocuments(filter),
            col.aggregate([
                { $match: filter },
                {
                    $group: {
                        _id: null,
                        pointsAdded: {
                            $sum: { $cond: [{ $gt: ['$change', 0] }, '$change', 0] }
                        },
                        pointsRemoved: {
                            $sum: { $cond: [{ $lt: ['$change', 0] }, { $abs: '$change' }, 0] }
                        }
                    }
                }
            ]).toArray()
        ]);

        const stats = {
            pointsAdded: statsAgg[0]?.pointsAdded || 0,
            pointsRemoved: statsAgg[0]?.pointsRemoved || 0
        };

        res.json({ data, total, limit, skip, stats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/get-logs', async (req, res) => {
    try {
        const db = await getDb();
        const { aula_name, search } = req.query;
        const { limit, skip } = parsePagination(req.query);
        const col = db.collection('logs');

        const filter = {};
        if (aula_name) filter.aula_name = aula_name;
        if (search) {
            filter.$or = [
                { nickname: { $regex: esc(search), $options: 'i' } },
                { reason: { $regex: esc(search), $options: 'i' } }
            ];
        }

        const [data, total] = await Promise.all([
            col.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
            col.countDocuments(filter)
        ]);

        res.json({ data, total, limit, skip });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`API rodando na porta ${PORT}`);
});
