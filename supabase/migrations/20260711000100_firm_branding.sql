-- F1: firm branding. One row per firm; the advisor's firm is the face on every
-- client-facing surface and document (owner report header/footer, owner portal).
-- Additive only. RLS: any firm member (advisor or owner) may read their firm's
-- branding so client-facing views render it; only advisors may write.

create table firm_branding (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null unique references firms (id),
  display_name text,
  logo_url text,             -- public URL or data: URI (dev has no storage bucket)
  accent_color text,         -- validated hex; overrides --accent on client views
  advisor_headshot_url text,
  footer_disclosure_md text, -- compliance text the firm controls
  report_from_line text,     -- e.g. "Prepared by Jane Doe, CFP®, Acme Wealth"
  constraint firm_branding_accent_hex
    check (accent_color is null
           or accent_color ~ '^#[0-9a-fA-F]{6}$'
           or accent_color ~ '^#[0-9a-fA-F]{3}$')
);

create index on firm_branding (firm_id);

create trigger firm_branding_touch
  before update on firm_branding
  for each row execute function app.touch_updated_at();

-- Grants (the blanket grant in the RLS migration predates this table).
grant select, insert, update, delete on firm_branding to authenticated;
grant all on firm_branding to service_role;

alter table firm_branding enable row level security;

-- Any authenticated member of the firm may read (advisors and owners): owner
-- portal and client-facing reports need the branding.
create policy firm_member_read on firm_branding for select to authenticated
  using (firm_id = app.user_firm_id());

-- Only advisors write.
create policy advisor_firm_write on firm_branding for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
