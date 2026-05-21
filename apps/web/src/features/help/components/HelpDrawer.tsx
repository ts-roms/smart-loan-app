import {
  Badge,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  Input,
} from "@loan/ui";
import { BookOpen, HelpCircle, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { HELP_ARTICLES, groupByCategory } from "../content";

/**
 * Navbar Help icon — opens a right-side drawer with a search box,
 * categorized article list, and a deep link out to /help for the full
 * reading experience.
 *
 * Placement: between the audit log trigger and the notification bell
 * in DashboardShell's header.
 */
export function HelpTrigger() {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          aria-label="Open help"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-white/70 hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </DrawerTrigger>
      <DrawerContent className="max-w-md">
        <HelpInspector onSelect={() => setOpen(false)} />
      </DrawerContent>
    </Drawer>
  );
}

function HelpInspector({ onSelect }: { onSelect: () => void }) {
  const [search, setSearch] = useState("");
  const grouped = groupByCategory();
  const categories = Object.keys(grouped) as Array<keyof typeof grouped>;

  const filtered = useMemo(() => {
    if (!search.trim()) return null;
    const needle = search.trim().toLowerCase();
    return HELP_ARTICLES.filter(
      (a) =>
        a.title.toLowerCase().includes(needle) ||
        a.summary.toLowerCase().includes(needle),
    );
  }, [search]);

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <BookOpen className="h-5 w-5 mt-0.5 text-sky-300" />
          <div className="flex-1 min-w-0">
            <DrawerTitle>Help & FAQ</DrawerTitle>
            <DrawerDescription>
              Per-module guides. Most pages also have a "Take a tour" button —{" "}
              <Link
                to="/help"
                onClick={onSelect}
                className="text-sky-300 hover:underline"
              >
                open the full help page →
              </Link>
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-white/45" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search help…"
            className="pl-7"
          />
        </div>

        {filtered ? (
          <div className="space-y-1.5">
            {filtered.length === 0 ? (
              <p className="text-xs text-white/55 px-1 py-2">No matches.</p>
            ) : (
              filtered.map((a) => (
                <ArticleLink key={a.id} article={a} onSelect={onSelect} />
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {categories.map((cat) => (
              <div key={cat}>
                <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5 px-1">
                  {cat}
                </div>
                <div className="space-y-1.5">
                  {grouped[cat].map((a) => (
                    <ArticleLink key={a.id} article={a} onSelect={onSelect} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </DrawerBody>
    </>
  );
}

function ArticleLink({
  article,
  onSelect,
}: {
  article: import("../content").HelpArticle;
  onSelect: () => void;
}) {
  return (
    <Link
      to={`/help#${article.id}`}
      onClick={onSelect}
      className="block rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 hover:bg-white/[0.06] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-white truncate">
            {article.title}
          </div>
          <div className="text-[10px] text-white/55 mt-0.5 line-clamp-2">
            {article.summary}
          </div>
        </div>
        {article.tour && (
          <Badge variant="muted" title="Has interactive tour">
            Tour
          </Badge>
        )}
      </div>
    </Link>
  );
}
