import { expect, test } from "vitest";
import { cotToSidc } from "./utils.js";

test("cotToSidc converts standard friendly ground unit", () => {
  const type = "a-f-G-U-C-I";
  const sidc = cotToSidc(type);
  expect(sidc).toBe("SFGPUCI--------");
});

test("cotToSidc handles missing type parts", () => {
  const type = "a-u-A";
  const sidc = cotToSidc(type);
  expect(sidc).toBe("SUAP-----------");
});

test("cotToSidc handles neutral affiliation with dot", () => {
  const type = "a-n.f-G";
  const sidc = cotToSidc(type);
  expect(sidc).toBe("SNGP-----------");
});

test("cotToSidc fallback for empty type", () => {
  expect(cotToSidc("")).toBe("SUGP-----------");
});
