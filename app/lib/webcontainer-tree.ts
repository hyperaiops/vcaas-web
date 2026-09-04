import type { FileSystemTree } from "@webcontainer/api";

export type TreeNode =
  | { kind: "directory"; children: Record<string, TreeNode> }
  | { kind: "file"; encoding: "utf-8" | "base64"; contents: string };

export type TreeResponse = {
  workspaceId: string;
  revision: string;
  root: TreeNode;
};

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("The file tree contains invalid base64 content.");
  }
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}

function validateName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error("The file tree contains an unsafe entry name.");
  }
}

function toEntries(node: TreeNode, depth = 0): FileSystemTree {
  if (node.kind !== "directory" || !node.children || depth > 32) {
    throw new Error("The file tree has an invalid directory structure.");
  }
  const tree: FileSystemTree = {};
  for (const [name, child] of Object.entries(node.children)) {
    validateName(name);
    if (child.kind === "directory") {
      tree[name] = { directory: toEntries(child, depth + 1) };
    } else if (child.kind === "file" && typeof child.contents === "string") {
      if (child.encoding !== "utf-8" && child.encoding !== "base64") {
        throw new Error("The file tree has an unknown file encoding.");
      }
      tree[name] = {
        file: { contents: child.encoding === "base64" ? decodeBase64(child.contents) : child.contents },
      };
    } else {
      throw new Error("The file tree contains an invalid entry.");
    }
  }
  return tree;
}

export function toFileSystemTree(response: TreeResponse): FileSystemTree {
  return toEntries(response.root);
}
