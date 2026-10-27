export function slugify(value) {
  const str = String(value);
  let result = '';
  let prevWasHyphen = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const code = char.charCodeAt(0);

    // Check if ASCII letter (A-Z or a-z) or digit (0-9)
    const isAsciiLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isAsciiDigit = code >= 48 && code <= 57;

    if (isAsciiLetter || isAsciiDigit) {
      // Lowercase ASCII letters only
      if (code >= 65 && code <= 90) {
        result += String.fromCharCode(code + 32);
      } else {
        result += char;
      }
      prevWasHyphen = false;
    } else {
      // Non-ASCII alphanumeric: replace with hyphen (collapse runs)
      if (!prevWasHyphen) {
        result += '-';
        prevWasHyphen = true;
      }
    }
  }

  // Trim leading and trailing hyphens
  return result.replace(/^-+|-+$/g, '');
}