import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ghRequest } from "./distribution-api.mjs";

// `gh api --include` prints the status line and headers, a blank line, then
// the body. HTTP/1.1 sends CRLF; gh's own rendering and HTTP/2 framing may
// give LF. Either must read as the same response.
const header = fc.record({
  name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,15}$/),
  value: fc.stringMatching(/^[!-~]([ -~]{0,20}[!-~])?$/),
});

const response = fc.record({
  status: fc.constantFrom(200, 202, 304, 403, 404, 422, 429, 500),
  protocol: fc.constantFrom("HTTP/1.1", "HTTP/2.0"),
  headers: fc.uniqueArray(header, { selector: (h) => h.name.toLowerCase(), maxLength: 5 }),
  body: fc.jsonValue().filter((value) => value !== null),
  pretty: fc.boolean(),
});

function render({ status, protocol, headers, body, pretty }, eol, trailing) {
  const head = [`${protocol} ${status} Reason`, ...headers.map(({ name, value }) => `${name}: ${value}`)];
  const json = JSON.stringify(body, null, pretty ? 2 : undefined);
  return `${head.join(eol)}${eol}${eol}${pretty ? json.replaceAll("\n", eol) : json}${trailing}`;
}

async function checkResponse(value, eol, trailing) {
  const stdout = render(value, eol, trailing);
  const result = await ghRequest("path", { execute: async () => ({ stdout }) });
  expect(result).toEqual({
    status: value.status,
    headers: Object.fromEntries(value.headers.map(({ name, value: v }) => [name.toLowerCase(), v])),
    // The wire carries serialized JSON: stringify turns -0 into 0, including
    // inside arrays/objects. Compare to that JSON value, not the JS input.
    body: JSON.parse(JSON.stringify(value.body)),
  });
}

describe("ghRequest (property)", () => {
  it("reads serialized negative zero as zero (shrunk counterexample)", async () => {
    await checkResponse({ status: 200, protocol: "HTTP/1.1", headers: [], body: [-0], pretty: false }, "\n", "");
  });

  it("reads the same status, headers and body whatever the line endings and final newline", async () => {
    await fc.assert(
      fc.asyncProperty(
        response,
        fc.constantFrom("\n", "\r\n"),
        fc.constantFrom("", "\n", "\r\n"),
        checkResponse,
      ),
    );
  });

  it("reads negative zero as the zero transmitted by JSON", async () => {
    const value = { status: 200, protocol: "HTTP/1.1", headers: [], body: { "": -0 }, pretty: false };
    const result = await ghRequest("path", {
      execute: async () => ({ stdout: render(value, "\n", "") }),
    });
    expect(result.body).toEqual({ "": 0 });
  });
});
