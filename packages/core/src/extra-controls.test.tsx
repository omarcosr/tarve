import { describe, expect, test } from "bun:test";
import { Button, Text, Window } from "./components";
import {
  AlertDialog,
  Avatar,
  Breadcrumb,
  Calendar,
  Collapsible,
  DataTable,
  DatePicker,
  HoverCard,
  Menubar,
  Pagination,
  Sheet,
  Skeleton,
  Spinner,
  Table,
  Toaster,
  type TableColumn,
} from "./extra-controls";
import { compileTree } from "./reconciler";

describe("extra controls", () => {
  test("renders loading, avatar, breadcrumb and pagination primitives with stable handlers", () => {
    const pages: number[] = [];
    let breadcrumbClicks = 0;
    const tree = compileTree(
      <Window>
        <Skeleton id="skeleton" width={120} height={20} />
        <Spinner id="spinner" label="Fetching data" />
        <Avatar id="avatar" fallback="MR" size={48} />
        <Breadcrumb id="crumbs" items={[
          { label: "Home", onClick: () => breadcrumbClicks++ },
          { label: "Projects", onClick: () => breadcrumbClicks++ },
          { label: "Tarve" },
        ]} />
        <Pagination id="pages" page={5} pageCount={10} onPageChange={page => pages.push(page)} />
      </Window>,
    );

    expect(tree.nodes.get("skeleton")?.style).toMatchObject({ width: 120, height: 20 });
    expect(tree.nodes.get("spinner")?.control).toEqual({ role: "progress", label: "Fetching data" });
    expect(tree.nodes.get("avatar-fallback")?.text).toBe("MR");
    expect(tree.nodes.get("crumbs-item-2")?.text).toBe("Tarve");
    tree.handlers.get("crumbs-item-0")?.onClick?.();
    expect(breadcrumbClicks).toBe(1);
    tree.handlers.get("pages-next")?.onClick?.();
    tree.handlers.get("pages-page-1")?.onClick?.();
    expect(pages).toEqual([6, 1]);
    expect(tree.nodes.get("pages-page-5")?.style.background).toBe("#18181b");
    expect(() => compileTree(<Window><Pagination page={0} pageCount={1} /></Window>)).toThrow(RangeError);
  });

  test("Calendar keeps month and date state controlled while enforcing date bounds", () => {
    const events: string[] = [];
    const tree = compileTree(
      <Window>
        <Calendar
          id="calendar"
          month="2026-09"
          value="2026-09-22"
          min="2026-09-10"
          max="2026-10-05"
          weekStartsOn={1}
          isDateDisabled={date => date === "2026-09-25"}
          onValueChange={date => events.push(`date:${date}`)}
          onMonthChange={month => events.push(`month:${month}`)}
        />
      </Window>,
    );

    expect(tree.nodes.get("calendar-label")?.text).toBe("September 2026");
    expect(tree.nodes.get("calendar-grid")?.control).toEqual({ role: "radiogroup", orientation: "horizontal" });
    expect(tree.nodes.get("calendar-day-2026-09-22")?.style.background).toBe("#18181b");
    expect(tree.nodes.get("calendar-day-2026-09-22")?.control).toEqual({
      role: "radio",
      label: "2026-09-22",
      checked: true,
      group: "calendar-grid",
    });
    expect(tree.nodes.get("calendar-day-2026-09-23")?.control).toEqual({
      role: "radio",
      label: "2026-09-23",
      checked: false,
      group: "calendar-grid",
    });
    expect(tree.nodes.get("calendar-day-2026-09-09")?.disabled).toBe(true);
    expect(tree.nodes.get("calendar-day-2026-09-25")?.disabled).toBe(true);
    expect(tree.nodes.get("calendar-day-2026-09-25")?.control?.group).toBe("calendar-grid");
    tree.handlers.get("calendar-day-2026-09-23")?.onClick?.();
    tree.handlers.get("calendar-previous")?.onClick?.();
    tree.handlers.get("calendar-next")?.onClick?.();
    expect(events).toEqual(["date:2026-09-23", "month:2026-08", "month:2026-10"]);

    expect(() => compileTree(<Window><Calendar month="2026-13" /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><Calendar month="2026-02" value="2026-02-30" /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><Calendar month="2026-09" min="2026-10-01" max="2026-09-01" /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><Calendar month="2026-09" weekStartsOn={7 as any} /></Window>)).toThrow(RangeError);
  });

  test("DatePicker uses a controlled popup Calendar and closes after selection", () => {
    const events: string[] = [];
    const closed = compileTree(
      <Window>
        <DatePicker
          id="date"
          open={false}
          month="2026-09"
          value="2026-09-22"
          onOpenChange={open => events.push(`open:${open}`)}
        />
      </Window>,
    );
    expect(closed.nodes.get("date-trigger")?.text).toBe("September 22, 2026");
    expect(closed.nodes.has("date-calendar")).toBe(false);
    closed.handlers.get("date-trigger")?.onClick?.();
    expect(events).toEqual(["open:true"]);

    const open = compileTree(
      <Window>
        <DatePicker
          id="date"
          open
          month="2026-09"
          value="2026-09-22"
          onOpenChange={next => events.push(`open:${next}`)}
          onValueChange={date => events.push(`date:${date}`)}
          onMonthChange={month => events.push(`month:${month}`)}
        />
      </Window>,
    );
    expect(open.nodes.has("date-calendar")).toBe(true);
    open.handlers.get("date-calendar-day-2026-09-24")?.onClick?.();
    open.handlers.get("date-calendar-next")?.onClick?.();
    expect(events).toEqual(["open:true", "date:2026-09-24", "open:false", "month:2026-10"]);

    expect(() => compileTree(
      <Window><DatePicker id="bad-date" open={false} month="2026-09" value="2026-09-31" /></Window>,
    )).toThrow(RangeError);
    expect(() => compileTree(
      <Window><DatePicker id="bad-range" open={false} month="2026-09" min="2026-10-01" max="2026-09-30" /></Window>,
    )).toThrow(RangeError);
  });

  test("Collapsible is controlled and only renders content while open", () => {
    const changes: boolean[] = [];
    const render = (open: boolean) => compileTree(
      <Window>
        <Collapsible id="details" open={open} trigger={<Text>Details</Text>} onOpenChange={value => changes.push(value)}>
          <Text id="details-body">Body</Text>
        </Collapsible>
      </Window>,
    );
    const closed = render(false);
    expect(closed.nodes.has("details-content")).toBe(false);
    expect(closed.nodes.get("details-trigger")?.control?.checked).toBe(false);
    closed.handlers.get("details-trigger")?.onClick?.();
    expect(changes).toEqual([true]);
    const open = render(true);
    expect(open.nodes.has("details-body")).toBe(true);
    expect(open.nodes.get("details-trigger")?.control?.checked).toBe(true);
  });

  test("Table and DataTable render typed columns, keyed rows and row actions", () => {
    type Person = { id: string; name: string; age: number };
    const columns: TableColumn<Person>[] = [
      { key: "name", header: "Name", accessor: "name" },
      { key: "age", header: "Age", accessor: "age", width: 80 },
    ];
    const selected: string[] = [];
    const data = [{ id: "ada", name: "Ada", age: 36 }, { id: "grace", name: "Grace", age: 40 }];
    const tree = compileTree(
      <Window>
        <Table id="people" columns={columns} data={data} rowKey={row => row.id} onRowClick={row => selected.push(row.id)} />
      </Window>,
    );
    expect(tree.nodes.has("people-header")).toBe(true);
    expect(tree.nodes.has("people-row-ada")).toBe(true);
    expect(tree.nodes.get("people-row-ada")?.control?.role).toBe("button");
    tree.handlers.get("people-row-grace")?.onClick?.();
    expect(selected).toEqual(["grace"]);

    const empty = compileTree(<Window><DataTable id="empty" columns={columns} data={[]} empty="Nothing here" /></Window>);
    expect(empty.nodes.has("empty-empty")).toBe(true);
    expect([...empty.nodes.values()].some(node => node.text === "Nothing here")).toBe(true);
    expect(() => compileTree(<Window><Table columns={[columns[0], columns[0]]} data={data} /></Window>)).toThrow(TypeError);
  });

  test("AlertDialog, Sheet and Toaster expose render-driven close/action handlers", () => {
    const events: string[] = [];
    const tree = compileTree(
      <Window>
        <AlertDialog
          id="confirm"
          open
          title="Delete project?"
          actionLabel="Delete"
          actionVariant="destructive"
          onAction={() => events.push("action")}
          onOpenChange={open => events.push(`dialog:${open}`)}
        />
        <Sheet id="sheet" open title="Settings" onOpenChange={open => events.push(`sheet:${open}`)}>
          <Text>Sheet body</Text>
        </Sheet>
        <Toaster
          id="toaster"
          toasts={[{ id: "saved", title: "Saved", description: "Changes persisted", variant: "success" }]}
          onDismiss={id => events.push(`dismiss:${id}`)}
        />
      </Window>,
    );

    expect(tree.nodes.get("confirm")?.modal).toBe(true);
    expect(tree.nodes.get("sheet")?.modal).toBe(true);
    expect(tree.nodes.get("toaster")?.style.position).toBe("absolute");
    tree.handlers.get("confirm-action")?.onClick?.();
    tree.handlers.get("sheet-close")?.onClick?.();
    tree.handlers.get("saved-dismiss")?.onClick?.();
    expect(events).toEqual(["action", "dialog:false", "sheet:false", "dismiss:saved"]);
  });

  test("Menubar and HoverCard keep visibility controlled while wiring selection and hover", () => {
    const events: string[] = [];
    const tree = compileTree(
      <Window>
        <Menubar
          id="menu"
          openMenu="file"
          menus={[{
            value: "file",
            label: "File",
            items: [{ value: "new", label: "New", shortcut: "Ctrl+N" }],
          }]}
          onOpenMenuChange={value => events.push(`menu:${value ?? "closed"}`)}
          onSelect={(menu, item) => events.push(`${menu}:${item}`)}
        />
        <HoverCard
          id="hover"
          open
          trigger={<Button>Account</Button>}
          onOpenChange={open => events.push(`hover:${open}`)}
        >
          <Text id="hover-body">Profile details</Text>
        </HoverCard>
      </Window>,
    );

    expect(tree.nodes.has("menu-content-file")).toBe(true);
    expect(tree.nodes.has("hover-content")).toBe(true);
    tree.handlers.get("menu-item-file-new")?.onClick?.();
    tree.handlers.get("hover-trigger")?.onHover?.(false);
    expect(events).toEqual(["file:new", "menu:closed", "hover:false"]);
  });
});
