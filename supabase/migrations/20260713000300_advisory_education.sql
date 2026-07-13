-- Learn content becomes a fourth Advisory Library item type. Education pieces
-- now live in advisory_library_items alongside buyer questions, initiatives, and
-- risk flags, and fire off the same score triggers — an education guide is
-- "recommended for you" when its governing DRS score is at or below its trigger,
-- exactly like the other item types. Advisors author them in the library; owners
-- read them in the portal's Learn tab.
--
-- Additive enum value; ALTER TYPE ADD VALUE commits here and is used by the seed
-- (a separate transaction), so the new value is available when the rows load.
alter type advisory_item_type add value if not exists 'education';
