// Shared SQL expressions over a `raw_events raw` row of source_type 'oireachtas_vote'.
// Constants only, so both the feed and the divisions module can import them without a cycle.

/** Division subject, falling back to the debate when the subject is empty or just "Question put:". */
export const VOTE_SUBJECT_SQL = `nullif(btrim(raw.raw_payload #>> '{division,subject,showAs}'), '')`;
export const VOTE_DEBATE_SQL = `nullif(btrim(raw.raw_payload #>> '{division,debate,showAs}'), '')`;
export const VOTE_DATE_SQL = `coalesce(raw.raw_payload #>> '{division,date}', raw.fetched_at::DATE::TEXT)`;
export const VOTE_HOUSE_SQL = `CASE WHEN raw.raw_payload #>> '{division,house,houseCode}' = 'seanad' THEN 'Seanad' ELSE 'Dáil' END`;
export const VOTE_TITLE_SQL = `CASE
  WHEN ${VOTE_SUBJECT_SQL} IS NULL THEN coalesce(${VOTE_DEBATE_SQL}, ${VOTE_HOUSE_SQL} || ' division')
  WHEN ${VOTE_SUBJECT_SQL} ~ ':\\s*$' THEN concat_ws(' — ', regexp_replace(${VOTE_SUBJECT_SQL}, ':\\s*$', ''), ${VOTE_DEBATE_SQL})
  ELSE ${VOTE_SUBJECT_SQL}
END`;
