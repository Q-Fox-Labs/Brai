// ABOUTME: Проверяет определение позиции курсора исходного inline-редактора.
// ABOUTME: DOM-контракт проверяется отдельно от браузерной проверки геометрии строки.
import assert from "node:assert/strict";
import { test } from "node:test";
import { detailOffsetAtPoint } from "../app/do/task-ui.ts";
import { formatCompactDuration } from "../app/do/demo-timer.ts";

function editorFixture(legacy = false) {
  const textNode = {};
  const calls: unknown[] = [];
  let end = 0;
  const point = (x: number, y: number) => {
    calls.push([x, y]);
    return legacy ? { startContainer: textNode, startOffset: 5 } : { offsetNode: textNode, offset: 5 };
  };
  const ownerDocument = {
    caretPositionFromPoint: legacy ? undefined : point,
    caretRangeFromPoint: legacy ? point : undefined,
    createRange: () => ({
      selectNodeContents: (node: unknown) => calls.push(node),
      setEnd: (node: unknown, offset: number) => {
        assert.equal(node, textNode);
        end = offset;
      },
      toString: () => "Разложить".slice(0, end),
    }),
  };
  const element = { ownerDocument, contains: (node: unknown) => node === textNode } as unknown as HTMLElement;
  return { element, calls };
}

test("editor caret follows the clicked character rather than the end of the title", () => {
  const { element, calls } = editorFixture();
  assert.equal(detailOffsetAtPoint(element, 483, 735), 5);
  assert.deepEqual(calls[0], [483, 735]);
  assert.equal(calls[1], element);
});

test("editor caret supports the original legacy DOM range fallback", () => {
  const { element } = editorFixture(true);
  assert.equal(detailOffsetAtPoint(element, 483, 735), 5);
});

test("a click outside the editor never reads text from another element", () => {
  const { element } = editorFixture();
  element.contains = () => false;
  assert.equal(detailOffsetAtPoint(element, 1, 1), 0);
});

test("mission duration uses September's seconds, minutes and hours formats", () => {
  assert.equal(formatCompactDuration(-1), "0");
  assert.equal(formatCompactDuration(9.9), "9");
  assert.equal(formatCompactDuration(65), "1:05");
  assert.equal(formatCompactDuration(3665), "1:01:05");
});
