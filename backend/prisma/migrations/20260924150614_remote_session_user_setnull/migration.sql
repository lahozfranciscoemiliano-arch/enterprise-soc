-- DropForeignKey
ALTER TABLE "remote_sessions" DROP CONSTRAINT "remote_sessions_userId_fkey";

-- AlterTable
ALTER TABLE "remote_sessions" ALTER COLUMN "userId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
