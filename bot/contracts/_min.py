# { "Depends": "py-genlayer:test" }
from genlayer import *


class Contract(gl.Contract):
    name: str
    fee: u256

    def __init__(self, name: str, fee: u256) -> None:
        self.name = name
        self.fee = fee

    @gl.public.view
    def get_name(self) -> str:
        return self.name

    @gl.public.view
    def get_fee(self) -> int:
        return int(self.fee)
