export function classifyStatus(status) {
  if (status >= 200 && status < 300) return "success";
  if (status >= 500) return "retry";
  if (status >= 400) return "failure";
  return "unknown";
}
