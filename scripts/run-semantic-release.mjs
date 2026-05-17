import { appendFileSync } from "node:fs";
import semanticRelease from "semantic-release";

const writeOutput = (name, value) => {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`, "utf8");
};

const result = await semanticRelease();

if (result === false) {
  writeOutput("new_release_published", "false");
  writeOutput("new_release_git_tag", "");
} else {
  writeOutput("new_release_published", "true");
  writeOutput("new_release_git_tag", result.nextRelease?.gitTag ?? "");
}
