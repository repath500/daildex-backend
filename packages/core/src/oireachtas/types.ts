export type OireachtasApiPage<T> = {
  head?: { counts?: { resultCount?: number } };
  results?: T[];
};

export type VoteMember = {
  member?: {
    showAs?: string;
    memberCode?: string;
  };
};

type OireachtasFormats = { xml?: { uri?: string } | null };

export type VoteResult = {
  division?: {
    uri?: string;
    voteId?: string;
    date?: string;
    outcome?: string;
    subject?: { showAs?: string; uri?: string | null };
    debate?: { showAs?: string; uri?: string; debateSection?: string; formats?: OireachtasFormats };
    tallies?: {
      taVotes?: { members?: VoteMember[] };
      nilVotes?: { members?: VoteMember[] };
      staonVotes?: { members?: VoteMember[] };
    };
  };
};

export type QuestionResult = {
  question?: {
    uri?: string;
    date?: string;
    questionNumber?: number;
    showAs?: string;
    by?: { showAs?: string; memberCode?: string };
    answerText?: string;
    debateSection?: {
      uri?: string;
      showAs?: string;
      debateSectionId?: string;
      formats?: OireachtasFormats;
    };
  };
};

export type DebateSpeaker = {
  showAs?: string;
  memberCode?: string;
};

export type DebateText = {
  speaker?: DebateSpeaker | null;
  text?: string;
};

export type DebateSection = {
  uri?: string;
  showAs?: string;
  containsDebate?: boolean;
  debateSectionId?: string;
  formats?: OireachtasFormats;
  text?: DebateText[];
};

export type DebateResult = {
  debateRecord?: {
    uri?: string;
    formats?: OireachtasFormats;
    date?: string;
    house?: { houseCode?: string; chamberType?: string };
    debateSections?: Array<{ debateSection?: DebateSection }>;
  };
};

export type OireachtasCategoryResult<T> =
  | { ok: true; items: T[] }
  | { ok: false; error: string };

export type OireachtasParticipant = {
  name: string;
  memberCode?: string;
  party: string | null;
  participation: string;
};

export type NormalizedParliamentaryRecord = {
  kind: "vote" | "question" | "debate";
  subject: string;
  date: string;
  outcome: string | null;
  sourceKey: string | null;
  url: string;
  participants: OireachtasParticipant[];
  sectionKey?: string;
  passages?: Array<{ url: string; text: string; speaker?: string; role: "question" | "answer" | "speech" }>;
};

export type OireachtasFetchOptions = {
  fetchImpl?: typeof fetch;
  limit?: number;
};
