import { handler, rateLimit } from "@/server/api";
import { decide } from "@/server/ai/decisions";
import { audit } from "@/server/repo/events";

/** One tiny decision with an obvious answer, to prove the key, endpoint and model work. */
export const POST = handler(async () => {
  rateLimit("decisions:test", 6, 3);
  const r = await decide({
    state: "Customer message: My payouts have failed for three days and payroll is due today.",
    questions: {
      is_urgent: { type: "noul", instructions: "Does the message describe an urgent problem?", criteria: { true: "A deadline or an active blockage is stated.", false: "No urgency is stated." } },
      team: { type: "choice", instructions: "Which team should handle it?", criteria: { billing: "Payments, payouts, invoices", technical: "Bugs and outages", other: "None of these" } },
    },
    purpose: "test", evenIfOff: true,
  });
  audit("decisions.tested", { model: r.model, ms: r.latencyMs });
  const urgent = r.answers.is_urgent;
  const team = r.answers.team;
  return {
    model: r.model, provider: r.provider, latencyMs: r.latencyMs, cost: r.usage.cost,
    urgent: urgent?.type === "noul" ? urgent.noul : null, team: team?.type === "choice" ? team.choice : null,
  };
});
