import os
import json
import math
from random import Random


class Singleton(type):
    _instances = {}

    def __call__(cls, *args, **kwargs):
        if cls not in cls._instances:
            cls._instances[cls] = super(Singleton, cls).__call__(*args, **kwargs)
        return cls._instances[cls]


class Randomizer(metaclass=Singleton):
    def __init__(self):
        random_seed = int(os.environ['SEED']) if 'SEED' in os.environ else None
        self.random = Random(random_seed)
        self._semantic_provider = None
        self._semantic_occurrences = {}

    def seed(self, seed):
        """Seed the legacy generator and reset optional semantic occurrences."""

        self.random.seed(seed)
        self._semantic_occurrences = {}

    def set_semantic_provider(self, provider):
        """Install an optional context-aware draw provider.

        The legacy path remains byte-for-byte equivalent when ``provider`` is
        ``None``: distributions continue to draw from ``self.random``.
        """

        if provider is not None and not callable(provider):
            raise TypeError('semantic random provider must be callable or None')
        self._semantic_provider = provider
        self._semantic_occurrences = {}

    @staticmethod
    def _plain_context(value):
        if value is None or isinstance(value, (bool, int, str)):
            return value
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError('semantic random context must be finite')
            return 0.0 if value == 0 else value
        if isinstance(value, dict):
            result = {}
            for key in sorted(value):
                if not isinstance(key, str) or not key:
                    raise ValueError('semantic random context keys must be non-empty strings')
                result[key] = Randomizer._plain_context(value[key])
            return result
        if isinstance(value, (list, tuple)):
            return [Randomizer._plain_context(item) for item in value]
        raise TypeError('semantic random context must be plain JSON-like data')

    def sample(self, family, parameters, units, context, legacy_sample):
        """Return a provider value or the unchanged legacy random value.

        ``context`` intentionally contains stable semantic fields only. The
        occurrence counter is per canonical context, never a global RNG order.
        """

        if self._semantic_provider is None:
            return legacy_sample()
        if not isinstance(family, str) or not family:
            raise ValueError('semantic random family must be non-empty')
        if not isinstance(units, str) or not units:
            raise ValueError('semantic random units must be non-empty')
        if not isinstance(parameters, dict):
            raise TypeError('semantic random parameters must be a dictionary')
        if not isinstance(context, dict) or 'occurrence' in context:
            raise ValueError('semantic random context must be a dictionary without occurrence')
        normalized_context = self._plain_context(context)
        normalized_parameters = self._plain_context(parameters)
        occurrence_key = json.dumps(
            {'family': family, 'parameters': normalized_parameters, 'units': units, 'context': normalized_context},
            ensure_ascii=False, sort_keys=True, separators=(',', ':')
        )
        occurrence = self._semantic_occurrences.get(occurrence_key, 0)
        self._semantic_occurrences[occurrence_key] = occurrence + 1
        provider_context = dict(normalized_context)
        provider_context['occurrence'] = occurrence
        value = self._semantic_provider(
            context=provider_context,
            family=family,
            parameters=normalized_parameters,
            units=units,
        )
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError('semantic random provider must return a numeric scalar')
        if not math.isfinite(float(value)):
            raise ValueError('semantic random provider must return a finite scalar')
        return value
