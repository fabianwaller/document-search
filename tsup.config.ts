import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        english: "src/english.ts",
        "english-synonyms": "src/english-synonyms.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    target: "es2022",
});