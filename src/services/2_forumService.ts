/**
 * Forum va Private Messages Service
 * Database'ga xabarlarni saqlash va olish
 */

import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface ForumPost {
  id: number;
  message_id: number;
  chat_id: number;
  user_id: number;
  username: string | null;
  text: string;
  created_at: Date;
  processed: boolean;
}

export interface PrivateMessage {
  id: number;
  user_id: number;
  username: string | null;
  message_text: string;
  ai_response: string | null;
  is_automated: boolean;
  created_at: Date;
  responded_at: Date | null;
}

/**
 * Forum xabarini database'ga saqlash
 */
export async function saveForumPost(
  messageId: number,
  chatId: number,
  userId: number,
  username: string | null,
  text: string
): Promise<ForumPost> {
  try {
    const result = await pool.query(
      `INSERT INTO forum_posts (message_id, chat_id, user_id, username, text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, chat_id) DO NOTHING
       RETURNING *`,
      [messageId, chatId, userId, username, text]
    );

    return result.rows[0];
  } catch (error) {
    console.error("❌ Forum xabari saqlanishda xatolik:", error);
    throw error;
  }
}

/**
 * Private xabarni database'ga saqlash
 */
export async function savePrivateMessage(
  userId: number,
  username: string | null,
  messageText: string,
  aiResponse: string | null = null,
  isAutomated: boolean = false
): Promise<PrivateMessage> {
  try {
    const result = await pool.query(
      `INSERT INTO private_messages (user_id, username, message_text, ai_response, is_automated)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, username, messageText, aiResponse, isAutomated]
    );

    return result.rows[0];
  } catch (error) {
    console.error("❌ Private xabari saqlanishda xatolik:", error);
    throw error;
  }
}

/**
 * AI javobini update qilish
 */
export async function updateMessageResponse(
  userId: number,
  messageText: string,
  aiResponse: string
): Promise<void> {
  try {
    await pool.query(
      `UPDATE private_messages
       SET ai_response = $1, is_automated = true, responded_at = NOW()
       WHERE user_id = $2 AND message_text = $3 AND ai_response IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [aiResponse, userId, messageText]
    );
  } catch (error) {
    console.error("❌ Javob update qilishda xatolik:", error);
    throw error;
  }
}

/**
 * Javob berilmagan xabarlarni olish (admin uchun)
 */
export async function getUnansweredMessages(): Promise<PrivateMessage[]> {
  try {
    const result = await pool.query(
      `SELECT * FROM private_messages
       WHERE ai_response IS NULL
       ORDER BY created_at ASC`
    );

    return result.rows;
  } catch (error) {
    console.error("❌ Unanswered messages olib kelishda xatolik:", error);
    throw error;
  }
}

/**
 * So'nggi forum xabarlarini olish
 */
export async function getRecentForumPosts(
  limit: number = 20
): Promise<ForumPost[]> {
  try {
    const result = await pool.query(
      `SELECT * FROM forum_posts
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  } catch (error) {
    console.error("❌ Forum xabarlarini olib kelishda xatolik:", error);
    throw error;
  }
}

/**
 * Forum statistikasi - admin uchun
 */
export async function getForumStats(): Promise<{
  totalPosts: number;
  totalUsers: number;
  lastMessageTime: Date | null;
}> {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_posts,
        COUNT(DISTINCT user_id) as total_users,
        MAX(created_at) as last_message_time
      FROM forum_posts
    `);

    const row = result.rows[0];
    return {
      totalPosts: parseInt(row.total_posts),
      totalUsers: parseInt(row.total_users),
      lastMessageTime: row.last_message_time,
    };
  } catch (error) {
    console.error("❌ Forum statistikasida xatolik:", error);
    throw error;
  }
}

/**
 * Private message statistikasi
 */
export async function getPrivateMessageStats(): Promise<{
  totalMessages: number;
  automatedResponses: number;
  unansweredMessages: number;
}> {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_messages,
        COUNT(CASE WHEN is_automated = true THEN 1 END) as automated,
        COUNT(CASE WHEN ai_response IS NULL THEN 1 END) as unanswered
      FROM private_messages
    `);

    const row = result.rows[0];
    return {
      totalMessages: parseInt(row.total_messages),
      automatedResponses: parseInt(row.automated),
      unansweredMessages: parseInt(row.unanswered),
    };
  } catch (error) {
    console.error("❌ Private message statistikasida xatolik:", error);
    throw error;
  }
}

/**
 * User bo'yicha private messages
 */
export async function getUserPrivateMessages(userId: number): Promise<PrivateMessage[]> {
  try {
    const result = await pool.query(
      `SELECT * FROM private_messages
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    return result.rows;
  } catch (error) {
    console.error("❌ User private messages olib kelishda xatolik:", error);
    throw error;
  }
}
