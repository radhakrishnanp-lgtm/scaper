import { handler } from "@/server/api";
import { fullGuide, GUIDE_TOPICS, guideGaps } from "@/server/ai/knowledge";
import { knowledgeDir, listNotes, listReviews, reviewStats } from "@/server/repo/knowledge";

export const dynamic = "force-dynamic";

/** What the agent knows: the guide it is given, its notes, and its reviews of its own work. */
export const GET = handler(async () => ({
  guide: fullGuide(),
  topics: GUIDE_TOPICS.map((t) => ({ id: t.id, title: t.title })),
  gaps: guideGaps(),
  notes: listNotes(),
  reviews: listReviews(30),
  stats: reviewStats(),
  folder: knowledgeDir(),
}));
