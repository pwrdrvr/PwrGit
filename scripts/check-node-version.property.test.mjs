import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkNvmrc } from "./check-node-version.mjs";
import { applyVariant, textVariant } from "./test-support/line-endings.mjs";

const version = fc.tuple(fc.nat({ max: 30 }), fc.nat({ max: 30 }), fc.nat({ max: 30 }));

describe(".nvmrc (property)", () => {
  it("pins the same version, and accepts the same Node, in any line-ending, BOM or final-newline form", () => {
    fc.assert(
      fc.property(
        version,
        version,
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        textVariant(),
        (pin, active, precision, prefix, variant) => {
          const pinned = `${prefix ? "v" : ""}${pin.slice(0, precision).join(".")}`;
          const node = `v${active.join(".")}`;
          const result = checkNvmrc(applyVariant(variant, `${pinned}\n`), node);
          expect(result).toEqual({
            pinned,
            matches: pin.slice(0, precision).every((part, i) => active[i] === part),
          });
        },
      ),
    );
  });
});
