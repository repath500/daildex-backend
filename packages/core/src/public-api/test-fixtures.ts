import type { Database } from "@daildex/db";

/**
 * Deterministic fixtures for integration tests of the public API: two active TDs and one former TD,
 * two divisions, a question with an answer, a debate contribution under a section heading, and a bill.
 * Every row is keyed so `cleanupPublicApiFixtures` removes exactly what was seeded.
 */
export async function seedPublicApiFixtures(database: Database): Promise<Record<string, string>> {
  // A previous run that died half-way must not break this one.
  await cleanupPublicApiFixtures(database);
  const ids: Record<string, string> = {};
  const tallyMembers = (codes: string[]) => ({ members: codes.map((code) => ({ member: { memberCode: code } })), tally: codes.length });

  const reps = await database<{ id: string; representative_key: string }[]>`
    INSERT INTO representatives (representative_key, name, chamber, role, area, party_name, status, source_member_code, source_uri, first_elected_date)
    VALUES
      ('t-jane-murphy', 'Jane Murphy', 'Dáil', 'TD', 'Cork South-Central', 'Fianna Fáil', 'active', 'T-Jane-Murphy', 'https://data.oireachtas.ie/ie/oireachtas/member/id/T-Jane-Murphy', '2024-11-29'),
      ('t-sean-byrne', 'Sean Byrne', 'Dáil', 'TD', 'Dublin Bay North', 'Sinn Féin', 'active', 'T-Sean-Byrne', NULL, NULL),
      ('t-old-td', 'Old Member', 'Dáil', 'TD', 'Kerry', 'Independent', 'former', 'T-Old-Member', NULL, NULL)
    RETURNING id, representative_key
  `;
  for (const rep of reps) ids[rep.representative_key] = rep.id;

  const division = (voteId: string, date: string, subject: string, outcome: string) => ({
    division: {
      uri: `https://data.oireachtas.ie/ie/oireachtas/division/house/dail/34/${date}/${voteId}`,
      voteId,
      date,
      datetime: `${date}T09:30:00+01:00`,
      outcome,
      subject: { showAs: subject },
      house: { houseNo: "34", houseCode: "dail" },
      debate: { showAs: "Housing Bill 2026: Report Stage", debateSection: "dbsect_13", uri: `https://data.oireachtas.ie/akn/ie/debateRecord/dail/${date}/debate/main` },
      tellers: "Tellers: Tá, Deputy A; Níl, Deputy B.",
      tallies: {
        taVotes: tallyMembers(["T-Jane-Murphy"]),
        nilVotes: tallyMembers(["T-Sean-Byrne", "T-Other"]),
        staonVotes: { members: [], tally: 0 },
      },
    },
  });
  const votes = [
    ["vote_1", "2026-09-29", "Amendment put: ", "Lost"],
    ["vote_2", "2026-09-30", "That the Bill be now read a Second Time", "Carried"],
  ] as const;
  for (const [voteId, date, subject, outcome] of votes) {
    const payload = division(voteId, date, subject, outcome);
    const text = [subject, "Housing Bill 2026: Report Stage", outcome].filter(Boolean).join(" — ");
    const [event] = await database<{ id: string }[]>`
      INSERT INTO raw_events (source_type, source_external_id, source_url, raw_payload, raw_text, dedupe_hash)
      VALUES ('oireachtas_vote', ${payload.division.uri}, ${payload.division.debate.uri}, ${database.json(payload)}, ${text}, ${`test-${voteId}`})
      RETURNING id
    `;
    ids[voteId] = event!.id;
    await database`
      INSERT INTO raw_event_targets (raw_event_id, representative_id, participation) VALUES
        (${event!.id}, ${ids["t-jane-murphy"]!}, 'Tá'),
        (${event!.id}, ${ids["t-sean-byrne"]!}, 'Níl')
    `;
  }

  // A parliamentary question with its answer.
  const questionUri = "https://data.oireachtas.ie/ie/oireachtas/question/2026-09-30/pq_77";
  const [questionDoc] = await database<{ id: string }[]>`
    INSERT INTO official_documents (source_type, source_uri, document_date, title, canonical_url, current_content_hash)
    VALUES ('oireachtas_question', ${questionUri}, '2026-09-30', 'Housing Policy', 'https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-09-30/questions/dbsect_5', 'h-q')
    RETURNING id
  `;
  const [questionVersion] = await database<{ id: string }[]>`
    INSERT INTO official_document_versions (official_document_id, content_hash, raw_payload) VALUES (${questionDoc!.id}, 'h-q', '{}'::JSONB) RETURNING id
  `;
  const [questionContribution] = await database<{ id: string }[]>`
    INSERT INTO official_contributions (official_document_version_id, representative_id, source_uri, ordinal, contribution_type, text, content_hash)
    VALUES (${questionVersion!.id}, ${ids["t-jane-murphy"]!}, ${questionUri}, 0, 'question', 'To ask the Minister for Housing how many social homes were delivered. Why 100% is not enough?', 'c-q')
    RETURNING id
  `;
  ids.question = questionContribution!.id;
  const questionPayload = { question: { uri: questionUri, questionNumber: 77, questionType: "oral", to: { showAs: "Department of Housing" }, answerText: "<p>The Minister said 10,000 homes.</p><p>More &amp; more.</p>" } };
  const [questionEvent] = await database<{ id: string }[]>`
    INSERT INTO raw_events (source_type, source_external_id, source_url, raw_payload, raw_text, dedupe_hash)
    VALUES ('oireachtas_question', ${questionUri}, ${questionUri}, ${database.json(questionPayload)}, 'q', 'test-q77')
    RETURNING id
  `;
  await database`
    INSERT INTO raw_event_targets (raw_event_id, representative_id, participation)
    VALUES (${questionEvent!.id}, ${ids["t-jane-murphy"]!}, 'asked')
  `;

  // A debate contribution under a section heading.
  const debateUri = "https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-10-01/debate/main";
  const sectionUri = "https://data.oireachtas.ie/akn/ie/debateRecord/dail/2026-10-01/debate/dbsect_9";
  const [debateDoc] = await database<{ id: string }[]>`
    INSERT INTO official_documents (source_type, source_uri, document_date, title, canonical_url, current_content_hash)
    VALUES ('oireachtas_debate', ${debateUri}, '2026-10-01', '34th Dáil debate — 2026-10-01', ${debateUri}, 'h-d')
    RETURNING id
  `;
  const [debateVersion] = await database<{ id: string }[]>`
    INSERT INTO official_document_versions (official_document_id, content_hash, raw_payload) VALUES (${debateDoc!.id}, 'h-d', '{}'::JSONB) RETURNING id
  `;
  const [speech] = await database<{ id: string }[]>`
    INSERT INTO official_contributions (official_document_version_id, representative_id, source_uri, section_id, ordinal, contribution_type, text, content_hash)
    VALUES (${debateVersion!.id}, ${ids["t-sean-byrne"]!}, ${`${sectionUri}#text-3`}, 'dbsect_9', 3, 'speech', 'We need homes, 100% sure; and 50_000 of them.', 'c-d')
    RETURNING id
  `;
  ids.speech = speech!.id;
  await database`
    INSERT INTO raw_events (source_type, source_external_id, source_url, raw_payload, raw_text, dedupe_hash)
    VALUES ('oireachtas_debate', ${`${sectionUri}::T-Sean-Byrne`}, ${sectionUri},
      ${database.json({ section: { uri: sectionUri, title: "Housing Delivery Statements" } })}, 'x', 'test-debate-9')
  `;

  // A bill with a stage history, a debate link and a document.
  const [bill] = await database<{ id: string }[]>`
    INSERT INTO legislation_documents (source_uri, bill_number, bill_year, title, long_title, status, source, current_stage, current_stage_date, current_content_hash)
    VALUES ('https://data.oireachtas.ie/ie/oireachtas/bill/2026/9042', '9042', '2026', 'Housing Bill 2026', 'An Act to provide for homes', 'Current', 'Government', 'Report Stage', '2026-09-30', 'h-b')
    RETURNING id
  `;
  ids.bill = bill!.id;
  await database`
    INSERT INTO legislation_versions (legislation_document_id, content_hash, raw_payload)
    VALUES (${bill!.id}, 'h-b', ${database.json({
      bill: {
        sponsors: [{ sponsor: { by: { showAs: "Minister for Housing" } } }],
        stages: [
          { event: { showAs: "Second Stage", stageCompleted: true, house: { showAs: "Dáil Éireann" }, dates: [{ date: "2026-07-01" }] } },
          { event: { showAs: "Report Stage", stageCompleted: false, house: { showAs: "Dáil Éireann" }, dates: [{ date: "2026-09-30" }] } },
        ],
      },
    })})
  `;
  await database`
    INSERT INTO legislation_debate_links (legislation_document_id, debate_uri, debate_section_id, debate_date, label)
    VALUES (${bill!.id}, ${debateUri}, 'dbsect_13', '2026-09-30', 'Report Stage')
  `;
  await database`
    INSERT INTO legislation_related_documents (legislation_document_id, source_uri, document_type, label, language, pdf_url)
    VALUES (${bill!.id}, 'https://data.oireachtas.ie/doc/1', 'bill', 'As initiated', 'eng', 'https://data.oireachtas.ie/doc/1.pdf')
  `;

  return ids;
}

export async function cleanupPublicApiFixtures(database: Database): Promise<void> {
  await database`DELETE FROM legislation_documents WHERE bill_number = '9042'`;
  await database`DELETE FROM official_documents WHERE title IN ('Housing Policy', '34th Dáil debate — 2026-10-01')`;
  await database`DELETE FROM raw_events WHERE dedupe_hash LIKE 'test-%'`;
  await database`DELETE FROM representatives WHERE representative_key LIKE 't-%'`;
}
