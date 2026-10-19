-- Restrict match schedule mutations to the owner.
-- Regular administrators can still manage stream links through the streams table policies.
begin;

drop policy if exists "Admins can add matches" on public."Matches";
drop policy if exists "Admins can update matches" on public."Matches";
drop policy if exists "Admins can delete matches" on public."Matches";
drop policy if exists "Owner can add matches" on public."Matches";
drop policy if exists "Owner can update matches" on public."Matches";
drop policy if exists "Owner can delete matches" on public."Matches";

create policy "Owner can add matches"
on public."Matches"
for insert
to authenticated
with check (public.is_owner());

create policy "Owner can update matches"
on public."Matches"
for update
to authenticated
using (public.is_owner())
with check (public.is_owner());

create policy "Owner can delete matches"
on public."Matches"
for delete
to authenticated
using (public.is_owner());

-- Only the owner can enumerate administrator accounts.
drop policy if exists "Admins can view admins" on public.admin_users;
drop policy if exists "Owner can view admins" on public.admin_users;

create policy "Owner can view admins"
on public.admin_users
for select
to authenticated
using (public.is_owner());

commit;
