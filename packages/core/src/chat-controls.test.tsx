import { describe, expect, test } from "bun:test";
import { Button, Column, Text, Window } from "./components";
import { compileTree } from "./reconciler";
import { Attachment, Bubble, Marker, Message, MessageScroller } from "./chat-controls";

describe("chat controls", () => {
  test("Attachment exposes upload state and removal", () => {
    let removed = 0;
    const tree = compileTree(<Window><Attachment id="file" name="report.pdf" size="2 MB" status="uploading" progress={65}
      onRemove={() => removed++} /></Window>);
    expect(tree.nodes.get("file-progress")?.control?.value).toBe(65);
    tree.handlers.get("file-remove")?.onClick?.();
    expect(removed).toBe(1);
    expect(() => compileTree(<Window><Attachment name="x" progress={101} /></Window>)).toThrow(RangeError);
  });

  test("Bubble, Marker and Message render conversation structure", () => {
    const tree = compileTree(<Window>
      <Bubble id="bubble" side="outgoing">Hello</Bubble>
      <Bubble id="nested-bubble" side="outgoing"><Text id="nested-copy">Nested</Text></Bubble>
      <Bubble id="deep-bubble" side="outgoing"><Column><Text id="deep-copy">Deep</Text></Column></Bubble>
      <Bubble id="button-bubble" side="outgoing"><Button id="nested-button">Action</Button></Bubble>
      <Marker id="marker" label="Today" />
      <Marker id="custom-marker"><Text id="marker-content">Custom</Text></Marker>
      <Marker id="zero-marker">{0}</Marker>
      <Message id="message" side="incoming" author="Alice" timestamp="10:00" actions={<Button>Reply</Button>}>
        <Text>Hi</Text>
      </Message>
    </Window>);
    expect(tree.nodes.get("bubble")?.style.background).toBe("#18181b");
    expect(tree.nodes.get("nested-copy")?.style.foreground).toBe(tree.nodes.get("nested-bubble")?.style.foreground);
    expect(tree.nodes.get("deep-copy")?.style.foreground).toBe(tree.nodes.get("deep-bubble")?.style.foreground);
    expect(tree.nodes.get("nested-button")?.text).toBe("Action");
    expect(tree.nodes.get("marker-content")?.kind).toBe("text");
    expect([...tree.nodes.values()].some(node => node.text === "0")).toBe(true);
    expect(tree.nodes.get("message-avatar")).toBeDefined();
    expect(tree.nodes.get("message-avatar-fallback")?.text).toBe("AL");
    expect(tree.nodes.get("message-bubble")).toBeDefined();
    expect(() => compileTree(<Window><Bubble maxWidth={0}>No</Bubble></Window>)).toThrow(RangeError);
  });

  test("MessageScroller is a bounded native scroll region", () => {
    const events: number[][] = [];
    const tree = compileTree(<Window><MessageScroller id="messages" height={240} onScroll={(offset, max) => events.push([offset, max])}>
      <Text>One</Text><Text>Two</Text></MessageScroller></Window>);
    expect(tree.nodes.get("messages")?.kind).toBe("scroll");
    expect(tree.nodes.get("messages")?.style.height).toBe(240);
    tree.handlers.get("messages")?.onScroll?.(20, 100);
    expect(events).toEqual([[20, 100]]);
    expect(() => compileTree(<Window><MessageScroller height={0}>Bad</MessageScroller></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><MessageScroller gap={-1}>Bad</MessageScroller></Window>)).toThrow(RangeError);
  });
});
