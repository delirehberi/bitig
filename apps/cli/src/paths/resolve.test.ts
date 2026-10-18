import { describe, expect, it } from "vitest";
import { resolveBitigPaths } from "./resolve";

describe("resolveBitigPaths", () => {
  const homedir = "/home/testuser";
  const noopRead = () => null;

  it("resolves default XDG paths when no flags or env set", () => {
    const res = resolveBitigPaths({
      env: {},
      homedir,
      readFileSync: noopRead,
    });

    expect(res.configFile).toBe("/home/testuser/.config/bitig/config.yaml");
    expect(res.configSource).toBe("default");
    expect(res.dataDir).toBe("/home/testuser/.local/share/bitig");
    expect(res.dataDirSource).toBe("default");
    expect(res.lockFile).toBe("/home/testuser/.local/share/bitig/.bitig.lock");
  });

  it("respects XDG environment variables", () => {
    const res = resolveBitigPaths({
      env: {
        XDG_CONFIG_HOME: "/custom/config",
        XDG_DATA_HOME: "/custom/data",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      homedir,
      readFileSync: noopRead,
    });

    expect(res.configFile).toBe("/custom/config/bitig/config.yaml");
    expect(res.dataDir).toBe("/custom/data/bitig");
    expect(res.lockFile).toMatch(/^\/run\/user\/1000\/bitig\/[a-f0-9]{16}\.lock$/);
  });

  it("ignores relative XDG variables according to spec", () => {
    const res = resolveBitigPaths({
      env: {
        XDG_DATA_HOME: "relative/path",
      },
      homedir,
      readFileSync: noopRead,
    });

    expect(res.dataDir).toBe("/home/testuser/.local/share/bitig");
  });

  it("flag overrides env and config for data-dir", () => {
    const res = resolveBitigPaths({
      flags: { dataDir: "~/my-tasks" },
      env: { BITIG_DATA_DIR: "/env/tasks" },
      homedir,
      readFileSync: (p) => (p.includes("config.yaml") ? "data_dir: /config/tasks\n" : null),
    });

    expect(res.dataDir).toBe("/home/testuser/my-tasks");
    expect(res.dataDirSource).toBe("flag");
  });

  it("throws when explicit config file is missing", () => {
    expect(() =>
      resolveBitigPaths({
        flags: { config: "/missing/config.yaml" },
        env: {},
        homedir,
        readFileSync: noopRead,
      }),
    ).toThrow(/explicit config file not found/i);
  });

  it("throws on unknown keys in config file", () => {
    expect(() =>
      resolveBitigPaths({
        env: {},
        homedir,
        readFileSync: () => "unknown_key: foo\n",
      }),
    ).toThrow(/config file/i);
  });
});

