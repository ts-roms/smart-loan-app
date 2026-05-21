import { Card, CardContent, CardHeader, CardTitle, Input } from "@loan/ui";
import { BookOpen, ExternalLink, HelpCircle, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { FAQ, HELP_ARTICLES, groupByCategory } from "../content";

/**
 * Help & FAQ page. Lists every help article grouped by category, with
 * a search input that filters titles + bodies. The FAQ at the bottom
 * collects cross-module questions.
 *
 * Each article links to its associated module route (when set) so the
 * reader can jump straight to the relevant page. The page itself has
 * no auth gates beyond being logged in — help should always be
 * reachable.
 */
export function HelpPage() {
  const [search, setSearch] = useState("");
  const grouped = groupByCategory();
  const categories = Object.keys(grouped) as Array<keyof typeof grouped>;

  const filtered = useMemo(() => {
    if (!search.trim()) return null;
    const needle = search.trim().toLowerCase();
    return HELP_ARTICLES.filter(
      (a) =>
        a.title.toLowerCase().includes(needle) ||
        a.summary.toLowerCase().includes(needle) ||
        a.body.toLowerCase().includes(needle),
    );
  }, [search]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-sky-300" />
            Help & FAQ
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-white/65 mb-3">
            Per-module guides + a cross-cutting FAQ. Most pages also have a
            "Take a tour" button in the top right — interactive walk-through
            highlighting the key controls.
          </p>
          <div className="relative max-w-xl">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/45" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search help articles…"
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      {/* Filtered results */}
      {filtered ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {filtered.length} result{filtered.length === 1 ? "" : "s"} for "
              {search}"
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {filtered.length === 0 ? (
              <p className="text-sm text-white/55">
                Nothing matched. Try a different keyword or scroll through the
                modules below.
              </p>
            ) : (
              filtered.map((a) => <ArticleBlock key={a.id} article={a} />)
            )}
          </CardContent>
        </Card>
      ) : (
        // Category sections
        categories.map((cat) => (
          <Card key={cat}>
            <CardHeader>
              <CardTitle className="text-sm">{cat}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {grouped[cat].map((a) => (
                <ArticleBlock key={a.id} article={a} />
              ))}
            </CardContent>
          </Card>
        ))
      )}

      {/* FAQ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <HelpCircle className="h-4 w-4" />
            Frequently asked questions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-4">
            {FAQ.map((item, i) => (
              <li key={i}>
                <h3 className="text-sm font-medium text-white">{item.q}</h3>
                <p className="text-sm text-white/65 mt-1 whitespace-pre-line">
                  {item.a}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function ArticleBlock({
  article,
}: {
  article: import("../content").HelpArticle;
}) {
  return (
    <article
      id={article.id}
      className="rounded-md border border-white/10 bg-white/[0.02] p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-white">{article.title}</h3>
          <p className="text-xs text-white/55 mt-0.5">{article.summary}</p>
        </div>
        {article.route && (
          <Link
            to={article.route}
            className="inline-flex items-center gap-1 text-xs text-sky-300 hover:underline shrink-0"
          >
            Open module <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </div>
      <p className="text-xs text-white/75 mt-2 whitespace-pre-line leading-relaxed">
        {article.body}
      </p>
    </article>
  );
}
