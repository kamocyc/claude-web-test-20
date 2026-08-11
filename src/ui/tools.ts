import type { BridgeTypeId, FoundationId, SupportId } from '../core/types.ts';
import { BRIDGES, DEMOLISH_COST, FILL_COST, FOUNDATION_COST, FOUNDATION_NAMES, SUPPORTS, SURVEY_COST } from '../core/config.ts';

export type Tool =
  | { kind: 'survey' }
  | { kind: 'dig' }
  | { kind: 'fill' }
  | { kind: 'support'; id: SupportId }
  | { kind: 'bridge'; id: BridgeTypeId }
  | { kind: 'foundation'; id: FoundationId }
  | { kind: 'demolish' };

export interface ToolDef {
  key: string;
  label: string;
  hint: string;
  group: string;
  tool: Tool;
}

export const TOOL_DEFS: ToolDef[] = [
  { key: '1', label: '調査(ボーリング)', hint: `${SURVEY_COST}`, group: '調査', tool: { kind: 'survey' } },
  { key: '2', label: '掘削', hint: '地質による', group: '土工', tool: { kind: 'dig' } },
  { key: '3', label: '盛土', hint: `${FILL_COST}`, group: '土工', tool: { kind: 'fill' } },
  { key: '4', label: SUPPORTS.timber.name, hint: `Lv1 / ${SUPPORTS.timber.cost}`, group: '支保', tool: { kind: 'support', id: 'timber' } },
  { key: '5', label: SUPPORTS.concrete.name, hint: `Lv2 / ${SUPPORTS.concrete.cost}`, group: '支保', tool: { kind: 'support', id: 'concrete' } },
  { key: '6', label: SUPPORTS.steel.name, hint: `Lv3 / ${SUPPORTS.steel.cost}`, group: '支保', tool: { kind: 'support', id: 'steel' } },
  { key: 'Q', label: BRIDGES.wood.name, hint: `支間${BRIDGES.wood.maxSpan}`, group: '橋', tool: { kind: 'bridge', id: 'wood' } },
  { key: 'W', label: BRIDGES.concrete.name, hint: `支間${BRIDGES.concrete.maxSpan}`, group: '橋', tool: { kind: 'bridge', id: 'concrete' } },
  { key: 'E', label: BRIDGES.steel.name, hint: `支間${BRIDGES.steel.maxSpan}`, group: '橋', tool: { kind: 'bridge', id: 'steel' } },
  { key: 'R', label: BRIDGES.truss.name, hint: `支間${BRIDGES.truss.maxSpan}`, group: '橋', tool: { kind: 'bridge', id: 'truss' } },
  { key: 'T', label: BRIDGES.suspension.name, hint: `支間${BRIDGES.suspension.maxSpan}`, group: '橋', tool: { kind: 'bridge', id: 'suspension' } },
  { key: 'A', label: FOUNDATION_NAMES.wide, hint: `${FOUNDATION_COST.wide}`, group: '基礎補強', tool: { kind: 'foundation', id: 'wide' } },
  { key: 'S', label: FOUNDATION_NAMES.pile, hint: `${FOUNDATION_COST.pile}`, group: '基礎補強', tool: { kind: 'foundation', id: 'pile' } },
  { key: 'D', label: '撤去', hint: `${DEMOLISH_COST}`, group: 'その他', tool: { kind: 'demolish' } },
];

export function toolLabel(tool: Tool): string {
  const def = TOOL_DEFS.find((d) => sameTool(d.tool, tool));
  return def ? def.label : '';
}

export function sameTool(a: Tool, b: Tool): boolean {
  if (a.kind !== b.kind) return false;
  return 'id' in a && 'id' in b ? a.id === b.id : true;
}
