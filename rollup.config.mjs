import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const sdPlugin = "com.avremy.openfortigate.sdPlugin";

export default {
  input: "src/plugin.ts",
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    sourcemap: true,
    sourcemapPathTransform: (rel, map) =>
      url.pathToFileURL(path.resolve(path.dirname(map), rel)).href,
  },
  plugins: [
    typescript({ mapRoot: undefined }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    { name: "emit-module-package-file", generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
    } },
  ],
};
