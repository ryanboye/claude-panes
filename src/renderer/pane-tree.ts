/**
 * Split pane binary tree data model and operations.
 */

export type SplitNode =
  | { type: 'leaf'; id: string; role?: string; rawTerminal?: boolean; terminalId?: string }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; children: [SplitNode, SplitNode] };

let nextId = 1;
export function generatePaneId(): string {
  return `pane-${nextId++}`;
}

export function createLeaf(id?: string, role?: string, rawTerminal?: boolean): SplitNode {
  const leaf: SplitNode = { type: 'leaf', id: id ?? generatePaneId(), role };
  if (rawTerminal) (leaf as any).rawTerminal = true;
  return leaf;
}

/**
 * Split a leaf pane into two. Returns new tree root.
 * Uses direct recursion (not mapNode) to avoid re-matching the same leaf
 * inside the newly created split node.
 */
export function splitPane(root: SplitNode, targetId: string, direction: 'horizontal' | 'vertical'): SplitNode {
  if (root.type === 'leaf') {
    if (root.id === targetId) {
      return {
        type: 'split',
        direction,
        ratio: 0.5,
        children: [root, createLeaf()],
      };
    }
    return root;
  }
  const newLeft = splitPane(root.children[0], targetId, direction);
  const newRight = splitPane(root.children[1], targetId, direction);
  if (newLeft !== root.children[0] || newRight !== root.children[1]) {
    return { ...root, children: [newLeft, newRight] };
  }
  return root;
}

/**
 * Split a leaf pane into two, where the new pane is a raw terminal (no Claude).
 */
export function splitPaneRaw(root: SplitNode, targetId: string, direction: 'horizontal' | 'vertical'): SplitNode {
  if (root.type === 'leaf') {
    if (root.id === targetId) {
      return {
        type: 'split',
        direction,
        ratio: 0.5,
        children: [root, createLeaf(undefined, undefined, true)],
      };
    }
    return root;
  }
  const newLeft = splitPaneRaw(root.children[0], targetId, direction);
  const newRight = splitPaneRaw(root.children[1], targetId, direction);
  if (newLeft !== root.children[0] || newRight !== root.children[1]) {
    return { ...root, children: [newLeft, newRight] };
  }
  return root;
}

/**
 * Close a leaf pane. Returns the sibling (promoted up).
 * If root is the target leaf, returns null.
 */
export function closePane(root: SplitNode, targetId: string): SplitNode | null {
  if (root.type === 'leaf') {
    return root.id === targetId ? null : root;
  }

  const [left, right] = root.children;

  // Direct child is the target — promote sibling
  if (left.type === 'leaf' && left.id === targetId) return right;
  if (right.type === 'leaf' && right.id === targetId) return left;

  // Recurse
  const newLeft = closePane(left, targetId);
  const newRight = closePane(right, targetId);

  if (newLeft === null) return newRight;
  if (newRight === null) return newLeft;

  return { ...root, children: [newLeft, newRight] };
}

/**
 * Update the split ratio for a split node containing the given child.
 */
export function resizePane(root: SplitNode, splitNodeChildId: string, ratio: number): SplitNode {
  return mapNode(root, (node) => {
    if (node.type === 'split') {
      const hasChild = (n: SplitNode): boolean =>
        n.type === 'leaf' ? n.id === splitNodeChildId : hasChild(n.children[0]) || hasChild(n.children[1]);
      if (hasChild(node.children[0]) || hasChild(node.children[1])) {
        return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
      }
    }
    return node;
  });
}

/**
 * Get all leaf IDs in order (left-to-right, top-to-bottom).
 */
export function getLeafIds(node: SplitNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [...getLeafIds(node.children[0]), ...getLeafIds(node.children[1])];
}

/**
 * Get a leaf node by ID.
 */
export function getLeaf(root: SplitNode, id: string): (SplitNode & { type: 'leaf' }) | null {
  if (root.type === 'leaf') return root.id === id ? root : null;
  return getLeaf(root.children[0], id) || getLeaf(root.children[1], id);
}

/**
 * Update a leaf's role.
 */
export function setLeafRole(root: SplitNode, leafId: string, role: string | undefined): SplitNode {
  return mapNode(root, (node) => {
    if (node.type === 'leaf' && node.id === leafId) {
      return { ...node, role };
    }
    return node;
  });
}

/**
 * Count leaf nodes.
 */
export function countLeaves(node: SplitNode): number {
  if (node.type === 'leaf') return 1;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

/**
 * Serialize tree for persistence (strips terminalId).
 */
export function serializeTree(node: SplitNode): unknown {
  if (node.type === 'leaf') {
    const data: any = { type: 'leaf', id: node.id, role: node.role };
    if (node.rawTerminal) data.rawTerminal = true;
    return data;
  }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    children: [serializeTree(node.children[0]), serializeTree(node.children[1])],
  };
}

/**
 * Deserialize tree from persistence.
 */
export function deserializeTree(data: any): SplitNode {
  if (!data || data.type === 'leaf') {
    return createLeaf(data?.id, data?.role, data?.rawTerminal);
  }
  return {
    type: 'split',
    direction: data.direction || 'vertical',
    ratio: data.ratio || 0.5,
    children: [deserializeTree(data.children?.[0]), deserializeTree(data.children?.[1])],
  };
}

// ─── Internal ────────────────────────────────────────────────

function mapNode(node: SplitNode, fn: (n: SplitNode) => SplitNode): SplitNode {
  const mapped = fn(node);
  if (mapped.type === 'split') {
    const newChildren: [SplitNode, SplitNode] = [
      mapNode(mapped.children[0], fn),
      mapNode(mapped.children[1], fn),
    ];
    if (newChildren[0] !== mapped.children[0] || newChildren[1] !== mapped.children[1]) {
      return { ...mapped, children: newChildren };
    }
  }
  return mapped;
}
