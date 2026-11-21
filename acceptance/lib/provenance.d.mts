export interface RequirementsBaseline {
  version: number;
  status: string;
  externalSpecification: {
    status: string;
    sha256: string | null;
    reason: string;
    retrieval: string;
  };
  mvp: {
    id: string;
    promise: string;
    requirements: {
      id: string;
      title: string;
      sources: string[];
      scenarios: { feature: string; name: string }[];
    }[];
    excluded: string[];
  };
  sources: { path: string; sha256: string; kind: string }[];
  requirements: {
    id: string;
    owner: string;
    scope: string;
    description: string;
    source: string;
    designPrinciples: string[];
    acceptance: { feature: string; tag: string };
  }[];
  decisions: { id: string; subject: string; status: string; owner: string }[];
}
export function requirementsBaseline(): RequirementsBaseline;
export function observeReference(
  previous: unknown,
  url: string,
  observation: unknown,
): { state: unknown; changes: unknown[] };
export function verifyArchive(path: string, expected: unknown): Promise<{ status: string }>;
export function licenceLedger(): { references: { qualifiedBuildInput: boolean }[] };
