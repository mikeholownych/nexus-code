import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, decodeHtmlEntities, htmlToReadableText } from "../src/core/html_text.js";

describe("htmlToText", () => {
  it("passes plain text through with collapsed whitespace", () => {
    assert.equal(htmlToText("hello   world\n\tnext"), "hello world next");
  });

  it("keeps a stray < before whitespace or digits as literal text", () => {
    assert.equal(htmlToText("5 < 6 and x <3"), "5 < 6 and x <3");
  });

  it("drops simple tags", () => {
    assert.equal(htmlToText("<p>hello <b>world</b></p>"), "hello world");
  });

  it("drops script elements with their contents and attributes", () => {
    assert.equal(htmlToText('a<script type="text/javascript">alert(1)</script>b'), "a b");
    assert.equal(htmlToText("a<SCRIPT>never()+runs()</SCRIPT>b"), "a b");
  });

  it("drops style elements with their contents", () => {
    assert.equal(htmlToText("a<style>p { color: red }</style>b"), "a b");
  });

  it("ends at the first close tag per raw-text semantics", () => {
    assert.equal(htmlToText("a<script>var x = '</script> here</script>b"), "a here b");
  });

  it("does not accept a longer close-tag name as a raw-text close", () => {
    assert.equal(htmlToText("a<script>drop</scriptx>b"), "a");
    assert.equal(htmlToText("a<style>drop</styley>b"), "a");
    // A boundary character (whitespace or /) after the exact name still closes.
    assert.equal(htmlToText("a<script>keep</script >b"), "a b");
    assert.equal(htmlToText("a<script>keep</script/>b"), "a b");
  });

  it("stays linear across many raw-text elements", () => {
    const many = "<script>x</script>".repeat(20_000);
    const started = Date.now();
    htmlToText(many);
    assert.ok(Date.now() - started < 1_000, "repeated elements must not degrade quadratically");
  });

  it("cannot be reassembled by nested malformed tags", () => {
    const attacked = "<scr<script>ipt>alert(1)</script>";
    const result = htmlToText(attacked);
    assert.equal(/<[a-zA-Z!/]/.test(result), false, result);
  });

  it("drops the rest of the input for unterminated tags or elements", () => {
    assert.equal(htmlToText("keep <script everything after"), "keep");
    assert.equal(htmlToText("keep <div"), "keep");
    assert.equal(htmlToText("keep <b<b>bold"), "keep bold");
  });

  it("handles comments, doctypes, and processing instructions", () => {
    assert.equal(htmlToText("a<!-- hidden -->b"), "a b");
    assert.equal(htmlToText("<!DOCTYPE html>body"), "body");
    assert.equal(htmlToText("a<?php gone ?>b"), "a b");
  });

  it("does not let a quoted > end a tag early", () => {
    const hostile = '<script x="> </script>LEAK">actual()</script>tail';
    const result = htmlToText(hostile);
    assert.equal(result, "tail");
    assert.equal(result.includes("LEAK"), false, result);
    assert.equal(result.includes("actual()"), false, result);
    assert.equal(htmlToText("<img src='x>y'>text"), "text");
  });

  it("ends comments at --> even when they contain >", () => {
    assert.equal(htmlToText("<!-- a > b -->tail"), "tail");
    assert.equal(htmlToText("keep <!-- no end"), "keep");
  });

  it("runs in bounded time on pathological shapes", () => {
    const pathological = "<".repeat(20_000) + "a".repeat(20_000) + "<script" + "x".repeat(20_000);
    const started = Date.now();
    htmlToText(pathological);
    assert.ok(Date.now() - started < 1_000, "scanner should stay linear");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes the fixed named set", () => {
    assert.equal(decodeHtmlEntities("&lt;a&gt; &quot;q&quot; &apos;p&apos; &nbsp;"), '<a> "q" \'p\'  ');
  });

  it("decodes amp last so double-encoded entities stay literal", () => {
    assert.equal(decodeHtmlEntities("&amp;lt;"), "&lt;");
    assert.equal(decodeHtmlEntities("&amp;amp;"), "&amp;");
  });

  it("decodes decimal and hex numeric references in range", () => {
    assert.equal(decodeHtmlEntities("&#65;&#x42;"), "AB");
    assert.equal(decodeHtmlEntities("&#0;"), "&#0;");
  });

  it("leaves unknown entities untouched", () => {
    assert.equal(decodeHtmlEntities("&unknown;"), "&unknown;");
  });

  it("never decodes a numeric entity into a terminal control character", () => {
    const decoded = decodeHtmlEntities("&#x1b;&#155;&#27;&#x7f;&#0;");
    assert.equal(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(decoded),
      false,
      JSON.stringify(decoded)
    );
    assert.equal(decodeHtmlEntities("&#65;&#x42;&#9;"), "AB\t");
  });
});

describe("htmlToReadableText", () => {
  it("combines extraction and decoding in the safe order", () => {
    assert.equal(htmlToReadableText('<p>a &amp; b</p><script>alert("&lt;")</script>tail'), "a & b tail");
  });

  it("never emits tags from hostile input", () => {
    const hostile = '<div><scr<script>ipt>x</script><img src=x onerror="y"></div>';
    const result = htmlToText(hostile);
    assert.equal(/<[a-zA-Z!/]/.test(result), false, result);
    // Entity-encoded markup decodes to literal text, which is data, not markup.
    assert.equal(htmlToReadableText("a &lt;iframe&gt; b"), "a <iframe> b");
  });

  it("strips raw terminal controls from untrusted page text", () => {
    const out = htmlToReadableText("a\u001b]0;title\u0007b\u009b2Jc");
    assert.equal(out, "a]0;titleb2Jc");
    assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(out), false);
  });

  it("keeps printable text when numeric entities try to inject escape sequences", () => {
    const out = htmlToReadableText("a&#x1b;]0;PWNED&#x1b;\\b&#155;2Jc");
    assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(out), false, JSON.stringify(out));
    assert.match(out, /PWNED/);
  });

  it("normalizes entity-decoded carriage returns and other line separators", () => {
    const out = htmlToReadableText("trusted&#13;spoof\nline\tcontinued");
    assert.equal(out, "trusted spoof line continued");
    assert.equal(/[\r\n\t]/.test(out), false, JSON.stringify(out));
  });
});
