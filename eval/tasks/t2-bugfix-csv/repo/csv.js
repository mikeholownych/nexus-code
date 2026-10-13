// Parses one CSV line into an array of field strings.
function parseLine(line) {
  return line.split(",").map((f) => f.trim());
}

module.exports = { parseLine };
