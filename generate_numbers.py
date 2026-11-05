import argparse
import json
import os
import random
import sqlite3
from pathlib import Path


def create_parser():
    parser = argparse.ArgumentParser(description="ビンゴのガチャレンジ！！")
    parser.add_argument(
        "count",
        nargs="?",
        type=int,
        choices=(1, 3),
        help="抽選回数（1または3、既定値: 1）",
    )
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--card", metavar="VISITOR_ID")
    operation.add_argument("--reset", action="store_true")
    operation.add_argument("--history", action="store_true")
    return parser


def main():
    parser = create_parser()
    args = parser.parse_args()
    if args.count is not None and (args.card or args.reset or args.history):
        parser.error("countは通常の抽選時のみ指定できます。")

    database_path = Path(
        os.environ.get("ADVENT_DB_PATH", Path(__file__).with_name("advent.db"))
    )
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS advent (
                number INTEGER PRIMARY KEY,
                drawn_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS bingo_cards (
                visitor_id TEXT PRIMARY KEY,
                numbers TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        if args.reset:
            connection.execute("DELETE FROM advent")
            return

        if args.history:
            history = connection.execute(
                "SELECT number, drawn_at FROM advent ORDER BY drawn_at, rowid"
            ).fetchall()
            print(json.dumps(
                [{"number": number, "drawn_at": drawn_at} for number, drawn_at in history],
                ensure_ascii=False,
            ))
            return

        if args.card:
            row = connection.execute(
                "SELECT numbers FROM bingo_cards WHERE visitor_id = ?",
                (args.card,),
            ).fetchone()
            if row is None:
                for _ in range(100):
                    numbers = random.sample(range(1, 21), 9)
                    serialized = json.dumps(numbers, separators=(",", ":"))
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO bingo_cards (visitor_id, numbers)
                        VALUES (?, ?)
                        """,
                        (args.card, serialized),
                    )
                    row = connection.execute(
                        "SELECT numbers FROM bingo_cards WHERE visitor_id = ?",
                        (args.card,),
                    ).fetchone()
                    if row is not None:
                        break
                else:
                    raise RuntimeError("重複しないビンゴカードを作成できませんでした。")

            print(row[0])
            return

        draw_count = args.count or 1
        drawn_numbers = {
            row[0] for row in connection.execute("SELECT number FROM advent")
        }
        available_numbers = set(range(1, 21)) - drawn_numbers

        if len(available_numbers) < draw_count:
            raise RuntimeError(f"残りの数字が{draw_count}個未満のため、抽選できません。")

        numbers = random.sample(tuple(available_numbers), draw_count)
        connection.executemany(
            "INSERT INTO advent (number) VALUES (?)",
            ((number,) for number in numbers),
        )

    for number in numbers:
        print(number)


if __name__ == "__main__":
    main()
