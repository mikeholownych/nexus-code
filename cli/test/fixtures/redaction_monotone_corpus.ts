/**
 * Inputs for the redaction monotonicity test: existing redaction shapes and templates plus generated adjacent, nested
 * and chained key shapes. All keys are synthetic. `redaction_base_spans.json` records the [start, end) spans the redactor classified in
 * each input before the encoded/dotted work (origin/main 29e7ebff).
 */
const KEYS = [
  "sk-ant-api03-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq",
  "sk-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0Ua",
  "sk-0123456789abcdefghij",
  "sk-proj7Ka+Mb3Qx/Zt9Lw2Vn5Hd8Rc1Yf4Jg6Pu0Eo+Sa/Tk",
  "sk-Qx7Km2Vb9LrTz4/Models",
  "sk-cache",
  "ghp_Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo",
  "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEYq9",
  "eyJhbGciOiJIUzI1NiJ9abc.eyJzdWIiOiIxMjM0NTY3ODkwIn0abc.SflKxwRJSMeKKF2QT4fwpMeJf36",
];
const JOINERS = [".", "/", "-", "_", "+", "%2F", "%2B", "∕", ";", ", ", " ", ".Xo2RtBq.", ".log", ".Models", "=", "\\/", "!", "?x="];
const WRAPPERS: Array<(s: string) => string> = [
  (s) => `request failed with key ${s} while connecting`,
  (s) => `the credential was ${s}.`,
  (s) => `token=${s} retry=1`,
  (s) => `{"api_key":"${s}","ok":false}`,
  (s) => `Authorization: Bearer ${s}`,
  (s) => `saved prefix_${s}.log and ${s}`,
  (s) => `GET https://llm.example/v1/models?key=${s}&x=1 failed`,
  (s) => s,
];

export function corpus(): string[] {
  const out = new Set<string>();
  for (const a of KEYS) {
    for (const wrap of WRAPPERS) out.add(wrap(a));
    for (const joiner of JOINERS) {
      for (const b of KEYS) {
        out.add(`${a}${joiner}${b}`);
        out.add(`${a}${joiner}${b}; saved prefix_${a}.log`);
      }
    }
  }
  return [...out];
}

