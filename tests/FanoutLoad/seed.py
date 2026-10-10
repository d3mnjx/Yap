"""Seed a stopped, empty /tmp/yap-fanout-* package after its first migration startup."""
import datetime
import json
import secrets
import sqlite3
import sys
import uuid
from pathlib import Path
root = Path(sys.argv[1]).resolve()
if root.parent != Path('/tmp') or not root.name.startswith('yap-fanout-'):
    raise SystemExit('Only disposable /tmp/yap-fanout-* packages are allowed')
db = sqlite3.connect(root / 'Data/yap.db')
if db.execute('SELECT COUNT(*) FROM Users').fetchone()[0]:
    raise SystemExit('Expected an empty Users table')
def guid():
    return str(uuid.uuid4()).upper()
def insert(table, values):
    for _, name, kind, required, default, _ in db.execute(f'PRAGMA table_info({table})'):
        if required and default is None and name not in values:
            values[name] = 0 if kind in ['INTEGER', 'REAL'] else ''
    db.execute(f'INSERT INTO {table} ({",".join(values)}) VALUES ({",".join("?" for _ in values)})', list(values.values()))
now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
people = [dict(id=guid(), username=f'fanout_{i}', token=secrets.token_hex(32)) for i in range(50)]
for person in people:
    insert('Users', dict(Id=person['id'], Username=person['username'], Token=person['token'], CreatedAt=str(now-datetime.timedelta(days=2)), Theme='discord-dark', TimeZone='UTC', Locale='en-US'))
room = db.execute('SELECT Id FROM Channels WHERE IsDefault=1').fetchone()[0]
# Five public rooms with 100 messages each expose snapshot/window scaling.
for index in range(5):
    channel = room if index == 0 else guid()
    if index:
        insert('Channels', dict(Id=channel, Type=0, Name=f'loadroom{index}', CreatedAt=str(now-datetime.timedelta(days=1))))
    for number in range(100):
        person = people[number % 50]
        insert('Messages', dict(Id=guid(), ChannelId=channel, UserId=person['id'], Username=person['username'], Content=f'Fixture {index}:{number}', Timestamp=str(now-datetime.timedelta(minutes=100-number)), ImageUrls='[]', VideoUrls='[]', GifAttachments='[]'))
db.commit()
db.close()
file = root/'fixture.json'
file.write_text(json.dumps(dict(people=people, room=room)))
file.chmod(0o600)
print('Seeded 50 synthetic users and 5 x 100 messages; credentials kept private.')
