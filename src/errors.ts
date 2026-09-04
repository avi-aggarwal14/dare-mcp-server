/** Error type carrying an agent-actionable remediation hint. */
export class DareError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly hint?: string;

  constructor(message: string, opts: { code?: string; status?: number; hint?: string } = {}) {
    super(message);
    this.name = "DareError";
    this.code = opts.code ?? "DARE_ERROR";
    this.status = opts.status;
    this.hint = opts.hint;
  }

  /** Message plus remediation, for surfacing to the calling model. */
  toAgentMessage(): string {
    const parts = [`[${this.code}] ${this.message}`];
    if (this.hint) parts.push(`Next step: ${this.hint}`);
    return parts.join("\n");
  }
}

const AUTH_HINT =
  "Set DARE_CLIENT_TOKEN to the `__client` cookie value from clerk.trydare.com while signed in to trydare.com " +
  "(DevTools > Application > Cookies > https://clerk.trydare.com). If it was already set, the session has expired " +
  "or been signed out — sign in again and copy a fresh value.";

export function authError(message: string): DareError {
  return new DareError(message, { code: "DARE_UNAUTHORIZED", status: 401, hint: AUTH_HINT });
}
