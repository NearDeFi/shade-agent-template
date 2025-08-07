// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract PriceOracle {
    uint256 private price;
    address public owner;
    
    event PriceUpdated(uint256 newPrice, address updatedBy);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    function updatePrice(uint256 _price) public onlyOwner {
        price = _price;
        emit PriceUpdated(_price, msg.sender);
    }

    function getPrice() public view returns (uint256) {
        return price;
    }
    
    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "New owner cannot be zero address");
        owner = newOwner;
    }
}
