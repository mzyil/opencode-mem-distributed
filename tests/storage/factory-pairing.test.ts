// tests/storage/factory-pairing.test.ts
import { describe, expect, test } from "bun:test";
import { validatePairing } from "../../src/services/storage/factory.ts";

describe("validatePairing", () => {
  test("accepts sqlite+usearch", () => {
    expect(() => validatePairing("sqlite", "usearch")).not.toThrow();
  });
  test("accepts sqlite+exact-scan", () => {
    expect(() => validatePairing("sqlite", "exact-scan")).not.toThrow();
  });
  test("rejects sqlite+pgvector", () => {
    expect(() => validatePairing("sqlite", "pgvector")).toThrow(/Invalid storage pairing/);
  });
  test("accepts postgres+pgvector", () => {
    expect(() => validatePairing("postgres", "pgvector")).not.toThrow();
  });
  test("accepts postgres+usearch and postgres+exact-scan", () => {
    expect(() => validatePairing("postgres", "usearch")).not.toThrow();
    expect(() => validatePairing("postgres", "exact-scan")).not.toThrow();
  });
  test("rejects libsql+pgvector", () => {
    expect(() => validatePairing("libsql", "pgvector")).toThrow(/Invalid storage pairing/);
  });
  test("accepts libsql+usearch and libsql+exact-scan", () => {
    expect(() => validatePairing("libsql", "usearch")).not.toThrow();
    expect(() => validatePairing("libsql", "exact-scan")).not.toThrow();
  });
});
