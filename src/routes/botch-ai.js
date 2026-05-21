import express from 'express';
import { body, validationResult } from 'express-validator';
import pool from '../db/index.js';
import { BOTCH_KNOWLEDGE_BASE } from '../lib/botch-knowledge.js';

const router = express.Router();

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  const text = normalizeText(value);
  if (!text) return [];
  return text.split(' ').filter((t) => t.length >= 2);
}

function scoreEntry(questionTokens, entry) {
  const hay = `${entry.title} ${entry.content} ${(entry.tags || []).join(' ')}`.toLowerCase();
  const unique = new Set(questionTokens);
  let score = 0;
  for (const token of unique) {
    if (hay.includes(token)) score += 1;
  }
  return score;
}

async function readCount(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    const value = rows?.[0]?.count ?? rows?.[0]?.total ?? 0;
    return Number(value) || 0;
  } catch (_) {
    return 0;
  }
}

async function getBotchLiveSnapshot() {
  const [
    activeProjects,
    totalProjects,
    publishedProperties,
    publishedVendorListings,
    totalUsers,
    totalMessages,
  ] = await Promise.all([
    readCount("SELECT COUNT(*) AS count FROM projects WHERE status = 'active'"),
    readCount('SELECT COUNT(*) AS count FROM projects'),
    readCount("SELECT COUNT(*) AS count FROM properties WHERE COALESCE(listing_state, publish_status, status, 'draft') = 'published'"),
    readCount("SELECT COUNT(*) AS count FROM vendor_listings WHERE workflow_state = 'published'"),
    readCount('SELECT COUNT(*) AS count FROM users'),
    readCount('SELECT COUNT(*) AS count FROM messages'),
  ]);

  return {
    activeProjects,
    totalProjects,
    publishedProperties,
    publishedVendorListings,
    totalUsers,
    totalMessages,
  };
}

function buildKnowledgeAnswer(matches) {
  if (!matches.length) {
    return `Botch helps with verified land sourcing, structured construction delivery, transparent payments, real-time updates, remote project control, sales support, and rental solutions.\n\nAsk me about any specific area and I will break it down clearly.`;
  }
  return matches
    .slice(0, 3)
    .map((m, idx) => `${idx + 1}. ${m.title}\n${m.content}`)
    .join('\n\n');
}

router.post(
  '/ask',
  [body('question').isString().trim().isLength({ min: 2, max: 500 })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const question = String(req.body.question || '').trim();
      const normalized = normalizeText(question);
      const tokens = tokenize(question);

      const ranked = BOTCH_KNOWLEDGE_BASE.map((entry) => ({
        ...entry,
        score: scoreEntry(tokens, entry),
      }))
        .sort((a, b) => b.score - a.score)
        .filter((entry) => entry.score > 0);

      const asksForLiveStats =
        /\b(how many|count|statistics|stats|numbers|overview|snapshot|live data|real time)\b/i.test(normalized);
      const asksGreeting = /\b(hi|hello|hey)\b/i.test(normalized);
      const asksAboutBotch = /\b(what is botch|about botch|who is botch|what does botch do)\b/i.test(normalized);
      const asksForBuildPlan = /\b(plan|planning|build|building|start building|construction plan|house plan)\b/i.test(normalized);

      const snapshot = asksForLiveStats ? await getBotchLiveSnapshot() : null;
      let answer = '';

      if (asksGreeting) {
        answer = 'Hi, I am the Botch AI Assistant. I can answer questions about Botch services, process, marketplace, project delivery, and platform workflows.';
      } else if (asksAboutBotch) {
        answer =
          'Botch is a real-estate and construction platform focused on verified land sourcing, transparent project delivery, trusted vendor operations, and remote project visibility for clients.';
      } else if (asksForBuildPlan) {
        answer = `Here is a practical Botch building plan you can follow:

1) Define scope and budget
- Confirm your target property type, timeline, and total budget.
- Set milestone checkpoints for design, structure, finishing, and handover.

2) Land and legal due diligence
- Run verification to avoid ownership disputes and legal surprises.
- Confirm land documentation before major spend starts.

3) Design and structured execution setup
- Finalize architectural/engineering direction.
- Break execution into trackable stages from foundation to completion.

4) Transparent payment and control
- Tie spending to milestones with clear records and receipts.
- Review progress updates before each major disbursement.

5) Delivery quality and finishing
- Use verified, durable materials and trusted service providers.
- Complete interior finishing with quality checks before handover.

If you want, I can give you a custom plan for your budget, location, and whether this is for living, resale, or rental income.`;
      } else {
        answer = buildKnowledgeAnswer(ranked);
      }

      if (snapshot) {
        answer += `\n\nLive Botch snapshot:\n- Active projects: ${snapshot.activeProjects}\n- Total projects: ${snapshot.totalProjects}\n- Published properties: ${snapshot.publishedProperties}\n- Published vendor listings: ${snapshot.publishedVendorListings}\n- Registered users: ${snapshot.totalUsers}\n- Messages exchanged: ${snapshot.totalMessages}`;
      }

      const suggestedQuestions = [
        'How does Botch keep land sourcing dispute-free?',
        'How does payment transparency work on Botch?',
        'How can I monitor my project remotely?',
        'What services are available in the vendor marketplace?',
      ];

      return res.json({
        question,
        answer,
        sources: ranked.slice(0, 3).map((r) => ({ id: r.id, title: r.title })),
        suggested_questions: suggestedQuestions,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

