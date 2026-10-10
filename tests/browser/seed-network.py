"""Seed stopped, disposable benchmark packages after their first migration startup.

Usage: python3 tests/browser/seed-network.py /tmp/yap-network-benchmark
Each reference/rewrite directory must be an isolated publish with Data/yap.db.
Never use this on the development instance. fixture.json contains synthetic credentials.
"""
import datetime
import json
import secrets
import shutil
import sqlite3
import sys
import uuid
from pathlib import Path

root = Path(sys.argv[1]).resolve()
if not str(root).startswith('/tmp/yap-network-'):
    raise SystemExit('Only disposable /tmp/yap-network-* directories are allowed')

def guid():
    return str(uuid.uuid4()).upper()

profiles = ['local', 'latency900', 'slow900']
now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
fixture = {}
for profile in profiles:
    people = [dict(id=guid(), username=f'bench_{profile}_{i}', token=secrets.token_hex(32)) for i in range(6)]
    fixture[profile] = dict(people=people, channels=[guid() for _ in range(5)])

for label in ['reference', 'rewrite']:
    package = root / label
    db = sqlite3.connect(package / 'Data/yap.db')
    if db.execute('SELECT COUNT(*) FROM Users').fetchone()[0]:
        raise SystemExit('Fixture must start with an empty Users table')
    def insert(table, values):
        # Fill required legacy fields explicitly; keep provider/schema defaults otherwise.
        for _, name, kind, required, default, _ in db.execute(f'PRAGMA table_info({table})'):
            if required and default is None and name not in values:
                values[name] = 0 if kind in ['INTEGER', 'REAL'] else ''
        db.execute(f'INSERT INTO {table} ({",".join(values)}) VALUES ({",".join("?" for _ in values)})', list(values.values()))
    uploads = package / 'wwwroot/uploads'
    uploads.mkdir(exist_ok=True)
    for profile, data in fixture.items():
        people = data['people']
        for person in people:
            insert('Users', dict(Id=person['id'], Username=person['username'], Token=person['token'], CreatedAt=str(now-datetime.timedelta(days=2)), Theme='discord-dark', TimeZone='UTC', Locale='en-US'))
        for index, channel in enumerate(data['channels']):
            buddy = people[index+1]
            insert('Channels', dict(Id=channel, Type=1, Name='', CreatedAt=str(now-datetime.timedelta(days=1)), Participant1Id=people[0]['id'], Participant2Id=buddy['id'], Participant1=people[0]['username'], Participant2=buddy['username']))
            for number in range(30):
                sender = people[0] if number % 2 else buddy
                images = []
                if number in [20, 25, 29]:
                    name = f'{profile}_{index}_{number}'
                    images = [f'/uploads/{name}.webp']
                    for suffix in ['', '_800px', '_1600px']:
                        shutil.copyfile(root/'image.webp', uploads/f'{name}{suffix}.webp')
                insert('Messages', dict(Id=guid(), ChannelId=channel, UserId=sender['id'], Username=sender['username'], Content=f'Fixture {index}:{number:02d} — a repeatable message with enough text to represent an ordinary chat conversation.', Timestamp=str(now-datetime.timedelta(minutes=60-number)), ImageUrls=json.dumps(images), VideoUrls='[]', GifAttachments='[]'))
    db.commit()
    db.close()
(root/'fixture.json').write_text(json.dumps(fixture))
(root/'fixture.json').chmod(0o600)
print('Seeded identical synthetic users and 5 × 30-message DMs per profile; credentials stay outside Git.')
