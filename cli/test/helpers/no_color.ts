/**
 * Colour off for a test file that runs the CLI in-process: `import "./helpers/no_color.js";` as the FIRST import.
 * picocolors reads NO_COLOR, FORCE_COLOR and CI once, when it loads, and turns colour on under CI even without a
 * terminal, so a test that asserts on printed text sees the product's own styling there but not on a developer's
 * shell (which often exports NO_COLOR). ES imports run in order, so this must come before anything that loads it.
 */
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = "1";
