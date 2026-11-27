#!/usr/bin/env python3
# interstellar_tg.py — helper Telegram untuk interstellar.js (Termux).
# Tugas: start bot @dac_agent dengan token (connect Telegram ke akun
# Interstellar) + join grup/channel target. Dipanggil oleh interstellar.js:
#   python3 interstellar_tg.py <token> <group_username>
# File yang dibaca (folder yang sama): tg_session.txt, tele_api.txt
# Output: baris [tg-py] ... ; exit 0 = OK, 1 = gagal.
import asyncio, sys, os

BASE = os.path.dirname(os.path.abspath(__file__)) + os.sep

def read(path):
    with open(path) as f:
        return f.read().strip()

async def main():
    token = sys.argv[1] if len(sys.argv) > 1 else ""
    group = sys.argv[2] if len(sys.argv) > 2 else "blockrium"
    # Nomor akun (1-based) = baris ke-N di sessions.txt, pasangan wallet.txt baris ke-N
    try:
        acct_no = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    except ValueError:
        acct_no = 1

    try:
        from pyrogram import Client
        from pyrogram.errors import UserAlreadyParticipant, FloodWait
    except ImportError:
        print("[tg-py] pyrogram belum terinstall (pip install pyrogram)")
        return 1

    try:
        api_lines = [l.strip() for l in read(BASE + "tele_api.txt").splitlines() if l.strip()]
        api_id = int(api_lines[0].split("=")[-1].strip())
        api_hash = api_lines[1].split("=")[-1].strip()
        # sessions.txt: 1 session per baris, dipasangkan per nomor akun dengan wallet.txt
        try:
            sess_lines = [l.strip() for l in read(BASE + "sessions.txt").splitlines() if l.strip()]
            if acct_no < 1 or acct_no > len(sess_lines):
                print(f"[tg-py] sessions.txt cuma {len(sess_lines)} baris, akun #{acct_no} tidak ada")
                return 1
            session = sess_lines[acct_no - 1]
        except FileNotFoundError:
            session = read(BASE + "tg_session.txt").splitlines()[0].strip()
    except Exception as e:
        print(f"[tg-py] gagal baca tele_api.txt/tg_session.txt: {e}")
        return 1

    app = Client("interstellar_tg", api_id=api_id, api_hash=api_hash, session_string=session)
    try:
        async with app:
            me = await app.get_me()
            print(f"[tg-py] login OK: @{me.username} id={me.id}")

            # 1) Start bot dac_agent dengan token -> link Telegram ke Interstellar
            if token:
                try:
                    await app.send_message("dac_agent", f"/start {token}")
                    print("[tg-py] bot @dac_agent di-start dengan token")
                    await asyncio.sleep(3)
                except Exception as e:
                    print(f"[tg-py] start bot gagal: {type(e).__name__}: {e}")
                    return 1

            # 2) Join grup/channel target
            try:
                chat = await app.join_chat(group)
                print(f"[tg-py] joined: {chat.title} id={chat.id}")
            except UserAlreadyParticipant:
                print("[tg-py] sudah member grup")
            except FloodWait as e:
                print(f"[tg-py] flood wait {e.value}s")
                return 1
            except Exception as e:
                print(f"[tg-py] join gagal: {type(e).__name__}: {e}")
                return 1

            # 3) Verifikasi member
            try:
                m = await app.get_chat_member(group, "me")
                print(f"[tg-py] status member: {m.status}")
            except Exception as e:
                print(f"[tg-py] cek member: {type(e).__name__}: {e}")
        print("[tg-py] OK")
        return 0
    except Exception as e:
        print(f"[tg-py] gagal: {type(e).__name__}: {e}")
        return 1

sys.exit(asyncio.run(main()))
