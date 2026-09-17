import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildShallowConvenienceLayerEvidence } from "../src/evidence/shallow-convenience-layer.js";
import type { ProjectFile } from "../src/types.js";

const smellyService = `import { userRepo } from "./user-repo";

export class UserService {
  getUser(id: string) {
    return userRepo.getUser(id);
  }

  saveUser(user: User) {
    return userRepo.saveUser(user);
  }

  deleteUser(id: string) {
    return userRepo.deleteUser(id);
  }
}
`;

const policyLayer = `import { userRepo } from "./user-repo";

export class UserService {
  async getUser(id: string) {
    const user = await userRepo.getUser(id);
    if (!user) throw new NotFoundError(id);
    return user;
  }

  saveUser(user: User) {
    return userRepo.saveUser(user);
  }

  deleteUser(id: string) {
    return userRepo.deleteUser(id);
  }
}
`;

const singleForwarder = `import { userRepo } from "./user-repo";

export function getUser(id: string) {
  return userRepo.getUser(id);
}

export function activeCount(users: User[]) {
  return users.filter((user) => user.active).length;
}
`;

const repo = `export const userRepo = {
  getUser(id: string) { return { id }; },
  saveUser(user: User) { return user; },
  deleteUser(id: string) { return true; },
};
`;

function candidateFor(filePath: string, source: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("shallow convenience layer evidence", () => {
  it("aggregates a class method set mirroring one collaborator", () => {
    const files: ProjectFile[] = [
      { filePath: "src/user-service.ts", source: smellyService },
      { filePath: "src/user-repo.ts", source: repo },
      {
        filePath: "src/handler.ts",
        source: `import { UserService } from "./user-service";\nimport { userRepo } from "./user-repo";\nuserRepo.getUser("1");`,
      },
    ];
    const evidence = buildShallowConvenienceLayerEvidence(
      candidateFor("src/user-service.ts", smellyService, "userRepo.getUser"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "getUser" },
      layer: { kind: "class", name: "UserService" },
      collaborator: {
        root: "userRepo",
        importedFrom: "./user-repo",
        ownership: "project-module",
      },
    });
    expect(evidence?.layer.members).toHaveLength(3);
    expect(evidence?.layer.members.every(({ hasBranching }) => !hasBranching)).toBe(true);
    expect(evidence?.collaborator.directImporters).toMatchObject([{ filePath: "src/handler.ts" }]);
    expect(evidence?.repository.layerImporters).toMatchObject([{ filePath: "src/handler.ts" }]);
  });

  it("still reports a layer where one method adds policy so Jev can weigh it", () => {
    const files: ProjectFile[] = [
      { filePath: "src/user-service.ts", source: policyLayer },
      { filePath: "src/user-repo.ts", source: repo },
    ];
    const evidence = buildShallowConvenienceLayerEvidence(
      candidateFor("src/user-service.ts", policyLayer, "userRepo.saveUser"),
      files,
    );
    expect(evidence?.layer.members).toMatchObject([
      { name: "getUser", forwardsTo: null, hasBranching: true },
      { name: "saveUser", forwardsTo: "userRepo", hasBranching: false },
      { name: "deleteUser", forwardsTo: "userRepo", hasBranching: false },
    ]);
  });

  it("abstains for a single forwarder in a module", () => {
    const files: ProjectFile[] = [
      { filePath: "src/users.ts", source: singleForwarder },
      { filePath: "src/user-repo.ts", source: repo },
    ];
    expect(buildShallowConvenienceLayerEvidence(
      candidateFor("src/users.ts", singleForwarder, "userRepo.getUser"),
      files,
    )).toBeUndefined();
  });

  it("abstains when methods target different collaborators", () => {
    const source = `import { userRepo } from "./user-repo";\nimport { auditLog } from "./audit";\nexport class Mixed {\n  get(id: string) {\n    return userRepo.getUser(id);\n  }\n  log(event: string) {\n    return auditLog.write(event);\n  }\n}`;
    const files: ProjectFile[] = [{ filePath: "src/mixed.ts", source }];
    expect(buildShallowConvenienceLayerEvidence(
      candidateFor("src/mixed.ts", source, "userRepo.getUser"),
      files,
    )).toBeUndefined();
  });
});
