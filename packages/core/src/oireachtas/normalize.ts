import type {
  DebateResult,
  NormalizedParliamentaryRecord,
  OireachtasParticipant,
  QuestionResult,
  VoteMember,
  VoteResult,
} from "./types";

export function normalizeDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (match?.[1]) return match[1];
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function dedupeParticipants(participants: OireachtasParticipant[]): OireachtasParticipant[] {
  const seen = new Set<string>();
  const out: OireachtasParticipant[] = [];
  for (const participant of participants) {
    const key = `${participant.name.toLocaleLowerCase("en-IE")}\0${participant.participation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(participant);
  }
  return out;
}

function membersFromTallies(
  members: VoteMember[] | undefined,
  participation: string,
): OireachtasParticipant[] {
  const out: OireachtasParticipant[] = [];
  for (const entry of members ?? []) {
    const name = entry.member?.showAs?.trim();
    if (!name) continue;
    out.push({ name, party: null, participation, ...(entry.member?.memberCode ? { memberCode: entry.member.memberCode } : {}) });
  }
  return out;
}

const PROCEDURAL_SUBJECT = /^(?:question|amendment)s?\b[^:]*:|^that\s+the\s+bill\b|:\s*$/i;

export function normalizeVote(result: VoteResult): NormalizedParliamentaryRecord | null {
  const division = result.division;
  if (!division) return null;

  const date = normalizeDate(division.date);
  if (!date) return null;

  const rawSubject = division.subject?.showAs?.trim() || "";
  const debateTitle = division.debate?.showAs?.trim() || "";
  // "Question put: That the Bill be now read a Second Time" says what was
  // voted on procedurally, not which Bill. Name the debate instead and keep
  // the procedural question with the outcome.
  const procedural = Boolean(rawSubject && debateTitle && PROCEDURAL_SUBJECT.test(rawSubject));
  const subject = (procedural ? debateTitle : rawSubject || debateTitle).trim();
  if (!subject) return null;
  const decision = division.outcome?.trim() || null;
  const ta = division.tallies?.taVotes?.members?.length ?? 0;
  const nil = division.tallies?.nilVotes?.members?.length ?? 0;
  const staon = division.tallies?.staonVotes?.members?.length ?? 0;
  const question = procedural ? rawSubject.replace(/:\s*$/, "").trim() : "";
  // Official totals travel with the result so no model has to count names.
  const totals = ta || nil || staon ? ` (Tá ${ta}, Níl ${nil}${staon ? `, Staon ${staon}` : ""})` : "";
  const outcome = decision || totals ? `${question ? `${question}: ` : ""}${decision ?? "Result"}${totals}` : null;

  const url =
    division.debate?.formats?.xml?.uri?.trim() ||
    division.debate?.uri?.trim() ||
    division.subject?.uri?.trim() ||
    division.uri?.trim() ||
    "";
  const sourceKey = division.uri?.trim() || division.voteId?.trim() || null;

  // Several divisions can share one debate; label each vote with its question
  // so a Tá on an amendment is never merged with a Níl on the final motion.
  const label = (vote: string) => (question ? `${vote} on ${question}` : vote);
  const participants = dedupeParticipants([
    ...membersFromTallies(division.tallies?.taVotes?.members, label("Tá")),
    ...membersFromTallies(division.tallies?.nilVotes?.members, label("Níl")),
    ...membersFromTallies(division.tallies?.staonVotes?.members, label("Staon")),
  ]);

  return {
    kind: "vote",
    subject,
    date,
    outcome,
    sourceKey,
    url,
    participants,
    ...(division.debate?.uri && division.debate.debateSection ? {
      sectionKey: `${division.debate.uri.trim().replace(/\/main\/?$/, "")}/${division.debate.debateSection}`,
    } : {}),
  };
}

export function normalizeQuestion(result: QuestionResult): NormalizedParliamentaryRecord | null {
  const question = result.question;
  if (!question) return null;

  const date = normalizeDate(question.date);
  if (!date) return null;

  const subject =
    question.debateSection?.showAs?.trim() ||
    question.showAs?.trim() ||
    (question.questionNumber != null ? `Question ${question.questionNumber}` : "");
  if (!subject) return null;

  const url =
    question.debateSection?.formats?.xml?.uri?.trim() ||
    question.debateSection?.uri?.trim() ||
    question.uri?.trim() ||
    "";
  const sourceKey = question.uri?.trim() || null;

  const participants: OireachtasParticipant[] = [];
  const asker = question.by?.showAs?.trim();
  if (asker) {
    participants.push({ name: asker, party: null, participation: "asked", ...(question.by?.memberCode ? { memberCode: question.by.memberCode } : {}) });
  }

  return {
    kind: "question",
    subject,
    date,
    outcome: null,
    sourceKey,
    url,
    participants,
    passages: [
      ...(question.showAs?.trim() ? [{ url, text: question.showAs.trim().slice(0, 6000), speaker: asker, role: "question" as const }] : []),
      ...(question.answerText?.trim() ? [{ url, text: question.answerText.trim().slice(0, 70000), role: "answer" as const }] : []),
    ],
  };
}

export function normalizeDebate(result: DebateResult): NormalizedParliamentaryRecord[] {
  const record = result.debateRecord;
  if (!record) return [];

  const date = normalizeDate(record.date);
  if (!date) return [];

  const out: NormalizedParliamentaryRecord[] = [];
  for (const entry of record.debateSections ?? []) {
    const section = entry.debateSection;
    if (!section) continue;
    if (section.containsDebate === false) continue;

    const subject = section.showAs?.trim() ?? "";
    if (!subject) continue;

    const speakers: OireachtasParticipant[] = [];
    for (const text of section.text ?? []) {
      const name = text.speaker?.showAs?.trim();
      if (!name) continue;
      speakers.push({ name, party: null, participation: "spoke", ...(text.speaker?.memberCode ? { memberCode: text.speaker.memberCode } : {}) });
    }

    out.push({
      kind: "debate",
      subject,
      date,
      outcome: null,
      sourceKey: section.uri?.trim() || null,
      url: section.formats?.xml?.uri?.trim() || record.formats?.xml?.uri?.trim() || section.uri?.trim() || record.uri?.trim() || "",
      ...(section.uri ? { sectionKey: section.uri.trim() } : {}),
      participants: dedupeParticipants(speakers),
      passages: (section.text ?? []).flatMap((entry) => entry.text?.trim() ? [{
        url: section.formats?.xml?.uri?.trim() || record.formats?.xml?.uri?.trim() || section.uri?.trim() || record.uri?.trim() || "",
        text: entry.text.trim().slice(0, 30000),
        speaker: entry.speaker?.showAs?.trim(), role: "speech" as const,
      }] : []).slice(0, 80),
    });
  }

  return out;
}
