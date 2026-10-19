-- Allow regular administrators to insert stream links only.
-- Owners retain the ability to update/delete existing links.
begin;

drop policy if exists "Admins can update streams" on public.streams;
drop policy if exists "Admins can delete streams" on public.streams;
drop policy if exists "Owner can update streams" on public.streams;
drop policy if exists "Owner can delete streams" on public.streams;

create policy "Owner can update streams"
on public.streams
for update
to authenticated
using (public.is_owner())
with check (public.is_owner());

create policy "Owner can delete streams"
on public.streams
for delete
to authenticated
using (public.is_owner());

commit;