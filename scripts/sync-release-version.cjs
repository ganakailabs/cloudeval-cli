const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const writeJson = (filePath, data) => {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const updatePackageVersion = (relativePath, version) => {
  const filePath = path.join(root, relativePath);
  const pkg = JSON.parse(fs.readFileSync(filePath, "utf8"));
  pkg.version = version;
  writeJson(filePath, pkg);
};

module.exports.prepare = async (_pluginConfig, context) => {
  const version = context.nextRelease && context.nextRelease.version;
  if (!version) {
    throw new Error("Missing semantic-release nextRelease.version.");
  }

  updatePackageVersion("package.json", version);
  updatePackageVersion("packages/cli/package.json", version);
  fs.writeFileSync(
    path.join(root, "packages/cli/src/version.ts"),
    `// Updated by semantic-release before each published release.\nexport const CLI_VERSION = ${JSON.stringify(version)};\n`
  );
};
