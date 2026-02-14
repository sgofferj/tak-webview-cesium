import { expect, test } from "vitest";
import { cotToSidc } from "./utils.js";

test("cotToSidc converts standard friendly ground unit", () => {
  const type = "a-f-G-U-C-I";
  const sidc = cotToSidc(type);
  expect(sidc).toBe("sfg-uci-----");
});

test("cotToSidc handles missing type parts", () => {
  const type = "a-u-A";
  const sidc = cotToSidc(type);
  expect(sidc).toBe("sua---------");
});

test("cotToSidc handles neutral affiliation with dot", () => {
  const type = "a-n.f-G";
  const sidc = cotToSidc(type);
  expect(sidc).toBe("sng---------");
});

test("cotToSidc fallback for empty type", () => {
  expect(cotToSidc("")).toBe("u-u-g-u---------");
});
