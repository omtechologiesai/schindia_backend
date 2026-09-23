"""
DynamoDB CRUD service layer.
Provides generic operations for all tables.
"""

import uuid
from datetime import datetime, date
from decimal import Decimal
from typing import Optional

from boto3.dynamodb.conditions import Key, Attr
from .client import get_table


def _serialize_value(value):
    """Convert Python values to DynamoDB-compatible types."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, set):
        return list(value)
    return value


def _serialize_item(item: dict) -> dict:
    """Serialize all values in a dict for DynamoDB."""
    return {k: _serialize_value(v) for k, v in item.items() if v is not None}


def _deserialize_item(item: dict) -> dict:
    """Convert DynamoDB item back to regular Python types."""
    result = {}
    for k, v in item.items():
        if isinstance(v, Decimal):
            # Convert Decimal to int or float
            if v == int(v):
                result[k] = int(v)
            else:
                result[k] = float(v)
        else:
            result[k] = v
    return result


class DynamoDBService:
    """Generic DynamoDB CRUD operations for a table."""

    def __init__(self, table_name: str):
        self.table_name = table_name

    @property
    def table(self):
        return get_table(self.table_name)

    def create(self, item: dict) -> dict:
        """Create a new item. Auto-generates id and timestamps if not present."""
        if 'id' not in item:
            item['id'] = str(uuid.uuid4())
        if 'created_at' not in item:
            item['created_at'] = datetime.utcnow().isoformat()
        item['updated_at'] = datetime.utcnow().isoformat()

        serialized = _serialize_item(item)
        self.table.put_item(Item=serialized)
        return _deserialize_item(serialized)

    def get(self, item_id: str, key_name: str = 'id') -> Optional[dict]:
        """Get a single item by ID."""
        response = self.table.get_item(Key={key_name: item_id})
        item = response.get('Item')
        if item:
            return _deserialize_item(item)
        return None

    def update(self, item_id: str, updates: dict, key_name: str = 'id') -> Optional[dict]:
        """Update an item by ID. Returns updated item.

        A value of None removes that attribute (used to clear optional
        foreign keys like session_id) rather than being silently skipped.
        """
        updates['updated_at'] = datetime.utcnow().isoformat()

        # Build update expression
        set_parts = []
        remove_parts = []
        expression_values = {}
        expression_names = {}

        for key, value in updates.items():
            safe_key = f"#{key}"
            expression_names[safe_key] = key
            if value is None:
                remove_parts.append(safe_key)
            else:
                val_key = f":{key}"
                set_parts.append(f"{safe_key} = {val_key}")
                expression_values[val_key] = _serialize_value(value)

        if not set_parts and not remove_parts:
            return self.get(item_id, key_name=key_name)

        clauses = []
        if set_parts:
            clauses.append("SET " + ", ".join(set_parts))
        if remove_parts:
            clauses.append("REMOVE " + ", ".join(remove_parts))
        update_expression = " ".join(clauses)

        kwargs = dict(
            Key={key_name: item_id},
            UpdateExpression=update_expression,
            ExpressionAttributeNames=expression_names,
            ReturnValues='ALL_NEW',
        )
        if expression_values:
            kwargs['ExpressionAttributeValues'] = expression_values

        response = self.table.update_item(**kwargs)
        return _deserialize_item(response.get('Attributes', {}))

    def delete(self, item_id: str) -> bool:
        """Delete an item by ID."""
        self.table.delete_item(Key={'id': item_id})
        return True

    def list_all(self) -> list:
        """Scan entire table. Use sparingly for small datasets."""
        response = self.table.scan()
        items = response.get('Items', [])

        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = self.table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))

        return [_deserialize_item(item) for item in items]

    def query_by_index(self, index_name: str, key_name: str, key_value: str) -> list:
        """Query items using a GSI."""
        response = self.table.query(
            IndexName=index_name,
            KeyConditionExpression=Key(key_name).eq(key_value),
        )
        items = response.get('Items', [])

        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = self.table.query(
                IndexName=index_name,
                KeyConditionExpression=Key(key_name).eq(key_value),
                ExclusiveStartKey=response['LastEvaluatedKey'],
            )
            items.extend(response.get('Items', []))

        return [_deserialize_item(item) for item in items]

    def query_by_field(self, field_name: str, field_value) -> list:
        """Scan with a filter (less efficient than GSI query, use for ad-hoc)."""
        response = self.table.scan(
            FilterExpression=Attr(field_name).eq(_serialize_value(field_value))
        )
        items = response.get('Items', [])

        while 'LastEvaluatedKey' in response:
            response = self.table.scan(
                FilterExpression=Attr(field_name).eq(_serialize_value(field_value)),
                ExclusiveStartKey=response['LastEvaluatedKey'],
            )
            items.extend(response.get('Items', []))

        return [_deserialize_item(item) for item in items]

    def batch_create(self, items: list) -> list:
        """Create multiple items in a batch."""
        created = []
        with self.table.batch_writer() as batch:
            for item in items:
                if 'id' not in item:
                    item['id'] = str(uuid.uuid4())
                if 'created_at' not in item:
                    item['created_at'] = datetime.utcnow().isoformat()
                item['updated_at'] = datetime.utcnow().isoformat()

                serialized = _serialize_item(item)
                batch.put_item(Item=serialized)
                created.append(_deserialize_item(serialized))
        return created

    def batch_delete(self, item_ids: list) -> bool:
        """Delete multiple items by ID."""
        with self.table.batch_writer() as batch:
            for item_id in item_ids:
                batch.delete_item(Key={'id': item_id})
        return True
