import argparse
import random
import sqlite3
from pathlib import Path


parser = argparse.ArgumentParser(description="未記録の数字を抽選します。")
parser.add_argument(
    "count",
    nargs="?",
    type=int,
    choices=(1, 3),
    default=1,
    help="抽選回数（1または3、既定値: 1）",
)
draw_count = parser.parse_args().count

database_path = Path(__file__).with_name("advent.db")

with sqlite3.connect(database_path) as connection:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS advent (
            number INTEGER PRIMARY KEY,
            drawn_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

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
