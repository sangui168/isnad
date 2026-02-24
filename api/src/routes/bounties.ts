import { Router, Request, Response } from 'express';

const router = Router();

// --- Types ---
interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  body: string | null;
  comments: number;
  labels: Array<{ name: string; color: string }>;
  assignee: { login: string; avatar_url: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface Bounty {
  id: number;
  number: number;
  title: string;
  tier: string | null;
  reward: number;
  status: 'open' | 'closed' | 'in-review';
  submissions: number;
  assignee: string | null;
  url: string;
  createdAt: string;
}

// --- Cache ---
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache: { data: GitHubIssue[] | null; timestamp: number } = { data: null, timestamp: 0 };

const REPO = 'counterspec/isnad';
const GITHUB_API = `https://api.github.com/repos/${REPO}/issues`;

async function fetchIssues(): Promise<GitHubIssue[]> {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  // Fetch both open and closed bounty issues
  const [openRes, closedRes] = await Promise.all([
    fetch(`${GITHUB_API}?labels=bounty&state=open&per_page=100`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'isnad-api' },
    }),
    fetch(`${GITHUB_API}?labels=bounty&state=closed&per_page=100`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'isnad-api' },
    }),
  ]);

  if (!openRes.ok || !closedRes.ok) {
    throw new Error(`GitHub API error: ${openRes.status} / ${closedRes.status}`);
  }

  const issues = [
    ...(await openRes.json()) as GitHubIssue[],
    ...(await closedRes.json()) as GitHubIssue[],
  ];

  cache = { data: issues, timestamp: now };
  return issues;
}

// --- Helpers ---
const TIER_LABELS: Record<string, string> = {
  'tier:critical': '🔴 Critical Pattern',
  'tier:improvement': '🟠 Detection Improvement',
  'tier:rule': '🟡 New Scanner Rule',
  'tier:docs': '🟢 Documentation',
  'tier:bug': '🔵 Bug Report',
};

const REWARD_PATTERN = /\*\*Reward:\*\*\s*([\d,]+)\s*\$?ISNAD/i;

function parseReward(issue: GitHubIssue): number {
  // Try body first
  if (issue.body) {
    const match = issue.body.match(REWARD_PATTERN);
    if (match) return parseInt(match[1].replace(/,/g, ''), 10);
  }
  // Fallback: infer from tier label
  const labels = issue.labels.map(l => l.name);
  if (labels.includes('tier:critical')) return 1000;
  if (labels.includes('tier:improvement')) return 500;
  if (labels.includes('tier:rule')) return 200;
  if (labels.includes('tier:docs')) return 100;
  if (labels.includes('tier:bug')) return 100;
  return 0;
}

function mapIssue(issue: GitHubIssue): Bounty {
  const labels = issue.labels.map(l => l.name);
  const tierLabel = labels.find(l => l.startsWith('tier:'));
  const hasInReview = labels.includes('in-review');

  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    tier: tierLabel ? (TIER_LABELS[tierLabel] || tierLabel) : null,
    reward: parseReward(issue),
    status: hasInReview ? 'in-review' : (issue.state as 'open' | 'closed'),
    submissions: issue.comments,
    assignee: issue.assignee?.login || null,
    url: issue.html_url,
    createdAt: issue.created_at,
  };
}

// --- Routes ---

// GET / - list all bounty issues
router.get('/', async (_req: Request, res: Response) => {
  try {
    const issues = await fetchIssues();
    const bounties = issues.map(mapIssue);
    res.json({ success: true, data: bounties });
  } catch (err: any) {
    console.error('Bounties fetch error:', err.message);
    res.status(502).json({ success: false, error: { code: 'GITHUB_ERROR', message: 'Failed to fetch bounties from GitHub' } });
  }
});

// GET /stats
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const issues = await fetchIssues();
    const bounties = issues.map(mapIssue);

    const open = bounties.filter(b => b.status === 'open' || b.status === 'in-review').length;
    const closed = bounties.filter(b => b.status === 'closed').length;
    const closedBounties = bounties.filter(b => b.status === 'closed');
    const totalPaid = closedBounties.reduce((sum, b) => sum + b.reward, 0);
    const contributors = new Set(closedBounties.map(b => b.assignee).filter(Boolean)).size;

    res.json({
      success: true,
      data: {
        totalPaid,
        openBounties: open,
        closedBounties: closed,
        contributors,
      },
    });
  } catch (err: any) {
    console.error('Stats fetch error:', err.message);
    res.status(502).json({ success: false, error: { code: 'GITHUB_ERROR', message: 'Failed to fetch bounty stats' } });
  }
});

// GET /leaderboard
router.get('/leaderboard', async (_req: Request, res: Response) => {
  try {
    const issues = await fetchIssues();
    const bounties = issues.map(mapIssue).filter(b => b.status === 'closed' && b.assignee);

    const byUser: Record<string, { bounties: number; earned: number }> = {};
    for (const b of bounties) {
      if (!b.assignee) continue;
      if (!byUser[b.assignee]) byUser[b.assignee] = { bounties: 0, earned: 0 };
      byUser[b.assignee].bounties++;
      byUser[b.assignee].earned += b.reward;
    }

    const leaderboard = Object.entries(byUser)
      .map(([username, data]) => ({ username, ...data }))
      .sort((a, b) => b.earned - a.earned)
      .map((entry, idx) => ({ rank: idx + 1, ...entry }));

    res.json({ success: true, data: leaderboard });
  } catch (err: any) {
    console.error('Leaderboard fetch error:', err.message);
    res.status(502).json({ success: false, error: { code: 'GITHUB_ERROR', message: 'Failed to fetch leaderboard' } });
  }
});

export default router;
