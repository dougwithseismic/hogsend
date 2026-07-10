ALTER TABLE "links" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "links_slug_unique" ON "links" USING btree ("slug");