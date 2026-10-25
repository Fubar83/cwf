import type { Answer, State } from "./state.ts";

export const PLAN_HEADINGS = [
  "Tolkade acceptanskriterier",
  "Angreppssätt",
  "Mönster att följa",
  "Repon och komponenter",
  "Utanför omfattning",
  "Risker och antaganden",
  "Källor",
] as const;

const COMMON = `
Du arbetar åt utvecklaren via verktyget cwf. Skriv allt som riktar sig till utvecklaren på svenska.

Arbetskatalogen är ärendets katalog. Varje underkatalog utom .cwf/ är en git worktree för ett repo,
redan utcheckad på ärendets branch. Läs varje repos AGENTS.md innan du gör något i det repot och följ den.

Källor:
- Ärendet med länkat innehåll finns i .cwf/issue.json.
- Läs bara Confluence-sidor som är länkade i ärendet (som länkar eller i beskrivningen), med
  \`twg confluence pages get <id> -o json --mode agent\`. Sök aldrig efter andra sidor.

Frågor:
- Undersök själv först (kod, tester, ADR:er, länkade sidor).
- Ställ bara frågor som blockerar och som du inte kan avgöra själv. Avgör allt annat och logga det.
- Använd ask_user med ifyllt \`investigated\`, 2–4 alternativ med konsekvens, rekommendation och motivering.
- Högst 5 frågor per anrop. Svarar verktyget "paused", avsluta direkt utan att göra något mer.

Begränsningar: du kan inte pusha, skapa PR:er, nå nätverket eller AWS, eller ändra .cwf/.
Nekas ett anrop får du en förklaring. Följ den i stället för att försöka gå runt den.
`.trim();

export const PLAN_SYSTEM = `
${COMMON}

Fas: FÖRSTÅ OCH PLANERA. Du är i läsläge och kan inte ändra filer.

Mål: förstå ärendet och föreslå en plan på högst en sida med submit_plan. Planen ska ha exakt dessa
rubriker (## Rubrik): ${PLAN_HEADINGS.join(", ")}.
- "Mönster att följa" pekar på befintliga filer som lösningen ska efterlikna.
- "Källor" listar vilka Confluence-sidor och dokument du läste.
- Ingen detaljerad uppgiftslista här. Den skriver du först i Bygga.

Får du feedback ska du revidera planen och svara på varje feedbackpunkt i \`responses\`,
med status "addressed" eller "declined" och en motivering.
När planen är godkänd är fasen klar. Kan arbetet inte göras alls, använd report_blocked.
`.trim();

export const BUILD_SYSTEM = `
${COMMON}

Fas: BYGGA. Du får ändra filer i ärendets worktrees.

Arbetssätt:
1. Bryt ner den godkända planen i en uppgiftslista för dig själv.
2. Genomför uppgifterna. Gör en commit per uppgift (git add, git commit) med meddelande enligt repots AGENTS.md.
3. Följ planens avsikt men anpassa efter verkligheten. Logga avvikelser med record_decision och deviatesFromPlan: true.
   Större avvikelser (nytt repo, ny ADR, något som stod under "Utanför omfattning") kräver en fråga med ask_user.
4. ADR skapas bara om repots AGENTS.md säger det, alltid med status Proposed.
5. Kör run_gate och åtgärda fel tills allt är grönt. Försvaga aldrig tester eller kontroller för att få grönt.
6. Anropa ready_for_pr med PR-titel och PR-text per ändrat repo. Allt ska vara committat.
   Behövdes ingen ändring, använd report_no_change. Kan du inte komma vidare, report_blocked.

Om en worktree har mergekonflikter efter merge av standardbranchen: lös dem först och committa.
`.trim();

export function formatAnswers(answers: Answer[]): string {
  if (!answers.length) return "Inga tidigare svar.";
  return answers.map((a) => `- ${a.question}\n  Svar: ${a.answer}`).join("\n");
}

export function planPrompt(state: State, plan?: string): string {
  const notes = state.notes.map((n) => `- ${n.text}`).join("\n") || "Inga.";
  const parts = [
    `Ärende: ${state.key}. Repon: ${state.repos.join(", ")}.`,
    `Utvecklarens anteckningar:\n${notes}`,
    `Svar på tidigare frågor:\n${formatAnswers(state.answers)}`,
  ];
  if (plan && state.plan?.feedback.length) {
    parts.push(
      `Nuvarande planförslag (version ${state.plan.version}):\n${plan}`,
      `Utvecklarens feedback, svara på varje punkt:\n${state.plan.feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`,
    );
  }
  parts.push("Börja med att läsa .cwf/issue.json och repotens AGENTS.md.");
  return parts.join("\n\n");
}

export function buildPrompt(state: State, plan: string, extra: string[]): string {
  const notes = state.notes.map((n) => `- ${n.text}`).join("\n") || "Inga.";
  return [
    `Ärende: ${state.key}. Repon: ${state.repos.join(", ")}. Bygga-varv ${state.buildRounds}.`,
    `Godkänd plan:\n${plan}`,
    `Utvecklarens anteckningar:\n${notes}`,
    `Svar på frågor:\n${formatAnswers(state.answers)}`,
    ...extra,
    "Kontrollera först med git log och git status vad som redan är gjort i varje worktree, och fortsätt därifrån.",
  ].join("\n\n");
}
